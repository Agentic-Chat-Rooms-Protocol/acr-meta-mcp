import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { MetaMcpService } from './service.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  apiToken?: string;
  allowedOrigins?: string[];
  allowedHosts?: string[];
}

export class MetaMcpServer {
  public readonly service = new MetaMcpService();
  private httpServer: Server | null = null;
  private apiToken: string = '';
  private extraAllowedOrigins: string[] = [];
  private extraAllowedHosts: string[] = [];

  private extractHostname(hostHeader: string | undefined): string {
    if (!hostHeader) return '';
    const trimmed = hostHeader.trim().toLowerCase();
    if (trimmed.startsWith('[')) {
      const endBracket = trimmed.indexOf(']');
      return endBracket !== -1 ? trimmed.slice(1, endBracket) : trimmed;
    }
    const colon = trimmed.indexOf(':');
    return colon !== -1 ? trimmed.slice(0, colon) : trimmed;
  }

  private isHostAllowed(req: IncomingMessage): boolean {
    const hostname = this.extractHostname(req.headers.host);
    if (!hostname) return true;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return true;
    }
    return this.extraAllowedHosts.some((h) => this.extractHostname(h) === hostname);
  }

  private isOriginAllowed(origin: string): boolean {
    if (!origin || origin === 'null') return false;
    if (this.extraAllowedOrigins.some((o) => o.toLowerCase() === origin.toLowerCase())) {
      return true;
    }
    try {
      const parsed = new URL(origin);
      const hostname = parsed.hostname.toLowerCase();
      if (parsed.protocol === 'https:' && (hostname === 'agentchatrooms.dev' || hostname === 'www.agentchatrooms.dev')) {
        return true;
      }
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private hasValidBearerToken(req: IncomingMessage): boolean {
    if (!this.apiToken) return true;
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return false;
    const provided = Buffer.from(auth.slice('Bearer '.length), 'utf8');
    const expected = Buffer.from(this.apiToken, 'utf8');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  private applySecurityAndCorsHeaders(req: IncomingMessage, res: ServerResponse): boolean {
    res.setHeader('Vary', 'Origin');
    if (!this.isHostAllowed(req)) {
      this.sendJson(res, 403, { error: 'Forbidden host header' });
      return false;
    }

    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!this.isOriginAllowed(origin)) {
        this.sendJson(res, 403, { error: 'Forbidden CORS origin' });
        return false;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Requested-With, X-ACR-Agent-DID, X-ACR-Role, Access-Control-Request-Private-Network'
      );
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
    } else if (req.method === 'OPTIONS') {
      this.sendJson(res, 403, { error: 'Origin header required for preflight' });
      return false;
    }
    return true;
  }

  private async parseJsonBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
        if (body.length > 10 * 1024 * 1024) {
          reject(new Error('Payload too large (limit 10MB)'));
        }
      });
      req.on('end', () => {
        if (!body) return resolve({});
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  public async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.applySecurityAndCorsHeaders(req, res)) {
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname !== '/health' && pathname !== '/api/v1/meta-mcp/health' && !this.hasValidBearerToken(req)) {
      this.sendJson(res, 401, { error: 'Unauthorized: valid Bearer token required.' });
      return;
    }

    try {
      // ─── Health check ──────────────────────────────────────────────
      if (req.method === 'GET' && (pathname === '/health' || pathname === '/api/v1/meta-mcp/health')) {
        this.sendJson(res, 200, {
          status: 'ONLINE',
          version: '1.0.0',
          protocol: 'meta-mcp/v1',
          uptime: process.uptime(),
          serverCount: this.service.registry.listServers().length,
        });
        return;
      }

      // ─── List Servers ──────────────────────────────────────────────
      if (req.method === 'GET' && pathname === '/api/v1/meta-mcp/servers') {
        const servers = this.service.registry.listServers();
        this.sendJson(res, 200, { servers, count: servers.length });
        return;
      }

      // ─── Import mcp_config.json ────────────────────────────────────
      if (req.method === 'POST' && pathname === '/api/v1/meta-mcp/servers/import') {
        const body = await this.parseJsonBody(req);
        const configStr = typeof body === 'string' ? body : JSON.stringify(body);
        const callerDid = (req.headers['x-acr-agent-did'] as string) || 'did:key:admin-local';
        const result = this.service.importMcpConfig(configStr, callerDid);
        this.sendJson(res, 200, { success: true, ...result });
        return;
      }

      // ─── Toggle Server Enable/Disable ──────────────────────────────
      const toggleMatch = pathname.match(/^\/api\/v1\/meta-mcp\/servers\/([^/]+)\/toggle$/);
      if (req.method === 'POST' && toggleMatch) {
        const serverId = decodeURIComponent(toggleMatch[1]);
        const body = await this.parseJsonBody(req);
        const updated = this.service.registry.toggleEnabled(serverId, body.enabled);
        this.service.auditLogger.record({
          eventType: 'SERVER_TOGGLE',
          actorDid: (req.headers['x-acr-agent-did'] as string) || 'did:key:admin-local',
          serverId,
          status: 'SUCCESS',
          details: { enabled: updated.enabled },
        });
        this.sendJson(res, 200, { success: true, server: updated });
        return;
      }

      // ─── Toggle Quarantine ─────────────────────────────────────────
      const quarantineMatch = pathname.match(/^\/api\/v1\/meta-mcp\/servers\/([^/]+)\/quarantine$/);
      if (req.method === 'POST' && quarantineMatch) {
        const serverId = decodeURIComponent(quarantineMatch[1]);
        const body = await this.parseJsonBody(req);
        const updated = this.service.registry.toggleQuarantine(serverId, body.quarantined);
        this.service.auditLogger.record({
          eventType: 'SERVER_QUARANTINE',
          actorDid: (req.headers['x-acr-agent-did'] as string) || 'did:key:admin-local',
          serverId,
          status: 'SUCCESS',
          details: { quarantined: updated.quarantined },
        });
        this.sendJson(res, 200, { success: true, server: updated });
        return;
      }

      // ─── VCS Provider Catalog Endpoints ───────────────────────────
      if (req.method === 'GET' && pathname === '/api/v1/meta-mcp/vcs/providers') {
        const adapters = this.service.vcsCatalog.listAdapters();
        const providers = adapters.map((a) => ({
          name: a.name,
          type: a.providerType,
          baseUrl: a.config.baseUrl,
          hasToken: Boolean(a.config.token),
          organization: a.config.organization,
          project: a.config.project,
        }));
        this.sendJson(res, 200, { providers, count: providers.length });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/v1/meta-mcp/vcs/providers') {
        const body = await this.parseJsonBody(req);
        if (!body.type) {
          this.sendJson(res, 400, { error: 'Missing required "type" field in VCS provider config.' });
          return;
        }
        this.service.registerVcsProvider(body);
        const registered = this.service.vcsCatalog.getAdapter(body.name || body.type);
        this.service.auditLogger.record({
          eventType: 'VCS_PROVIDER_REGISTER',
          actorDid: (req.headers['x-acr-agent-did'] as string) || 'did:key:admin-local',
          serverId: `vcs-${registered?.name || body.type}`,
          status: 'SUCCESS',
          details: { type: body.type, baseUrl: body.baseUrl },
        });
        this.sendJson(res, 201, {
          success: true,
          provider: {
            name: registered?.name,
            type: registered?.providerType,
            baseUrl: registered?.config.baseUrl,
          },
        });
        return;
      }

      const vcsHealthMatch = pathname.match(/^\/api\/v1\/meta-mcp\/vcs\/providers\/([^/]+)\/health$/);
      if (req.method === 'GET' && vcsHealthMatch) {
        const providerName = decodeURIComponent(vcsHealthMatch[1]);
        const adapter = this.service.vcsCatalog.getAdapter(providerName);
        if (!adapter) {
          this.sendJson(res, 404, { error: `VCS provider "${providerName}" not found.` });
          return;
        }
        const health = await adapter.healthCheck();
        this.sendJson(res, 200, { success: true, provider: adapter.name, health });
        return;
      }

      // ─── Query Catalogs (Raw, Policy, Projected) ───────────────────
      if (req.method === 'GET' && pathname === '/api/v1/meta-mcp/tools') {
        const view = url.searchParams.get('view') || 'projected';
        const callerRole = (req.headers['x-acr-role'] as any) || url.searchParams.get('role') || 'agent';
        const callerDid = (req.headers['x-acr-agent-did'] as string) || url.searchParams.get('did') || 'did:key:caller-anonymous';

        if (view === 'raw') {
          this.sendJson(res, 200, this.service.getRawCatalog());
          return;
        }
        if (view === 'policy') {
          this.sendJson(res, 200, this.service.getPolicyCatalog());
          return;
        }

        const projected = this.service.getProjectedCatalog({ did: callerDid, role: callerRole });
        this.sendJson(res, 200, projected);
        return;
      }

      // ─── Execute Tool Call ─────────────────────────────────────────
      if (req.method === 'POST' && pathname === '/api/v1/meta-mcp/tools/call') {
        const body = await this.parseJsonBody(req);
        const toolName = body.name || body.toolName;
        const args = body.arguments || body.args || {};
        const caller = {
          did: (req.headers['x-acr-agent-did'] as string) || body.callerDid || 'did:key:caller-anonymous',
          role: (req.headers['x-acr-role'] as any) || body.role || 'agent',
          roomContext: (req.headers['x-acr-room'] as string) || body.roomContext,
        };

        if (!toolName) {
          this.sendJson(res, 400, { error: 'Missing "name" field in request payload.' });
          return;
        }

        const result = await this.service.executeToolCall(caller, toolName, args);
        let statusCode = 200;
        if (result.status === 'DENIED') {
          statusCode = result.result?.error?.includes('422') ? 422 : 403;
        } else if (result.status === 'ERROR') {
          statusCode = 500;
        }
        this.sendJson(res, statusCode, result);
        return;
      }

      // ─── PayloadGuard Scan Endpoint ───────────────────────────────
      if (req.method === 'POST' && pathname === '/api/v1/meta-mcp/guard/scan') {
        const body = await this.parseJsonBody(req);
        const scan = this.service.payloadGuard.scan(body.payload ?? body);
        this.sendJson(res, scan.level === 'malicious' ? 422 : 200, scan);
        return;
      }

      // ─── PayloadGuard Scrub Endpoint ──────────────────────────────
      if (req.method === 'POST' && pathname === '/api/v1/meta-mcp/guard/scrub') {
        const body = await this.parseJsonBody(req);
        const sanitized = this.service.payloadGuard.sanitize(body.payload ?? body);
        this.sendJson(res, 200, sanitized);
        return;
      }

      // ─── Vault Management (SQLite3MultipleCiphers & SQLCipher Engine) ──────
      if (req.method === 'GET' && pathname === '/api/v1/meta-mcp/vault/secrets') {
        const secrets = this.service.listVaultSecrets();
        this.sendJson(res, 200, { secrets, count: secrets.length });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/v1/meta-mcp/vault/secrets') {
        const body = await this.parseJsonBody(req);
        if (!body.serverId || !body.key || !body.value) {
          this.sendJson(res, 400, { error: 'Missing "serverId", "key", or "value" in payload.' });
          return;
        }
        const created = this.service.storeVaultSecret(
          body.serverId,
          body.key,
          body.value,
          body.domain || 'personal',
          body.cipher || 'aes-256-gcm'
        );
        this.sendJson(res, 201, { success: true, secret: created });
        return;
      }

      if (req.method === 'DELETE' && pathname.startsWith('/api/v1/meta-mcp/vault/secrets/')) {
        const refId = pathname.replace('/api/v1/meta-mcp/vault/secrets/', '');
        const deleted = this.service.deleteVaultSecret(refId);
        this.sendJson(res, 200, { success: deleted, refId });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/v1/meta-mcp/vault/rotate') {
        const body = await this.parseJsonBody(req);
        if (!body.newMasterSecret) {
          this.sendJson(res, 400, { error: 'Missing "newMasterSecret" in payload.' });
          return;
        }
        this.service.rotateVaultMasterKey(body.newMasterSecret);
        this.sendJson(res, 200, { success: true, message: 'Vault master key rotated and database re-encrypted.' });
        return;
      }

      // ─── Audit Trail ───────────────────────────────────────────────
      if (req.method === 'GET' && pathname === '/api/v1/meta-mcp/audit') {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const logs = this.service.auditLogger.getRecent(limit);
        this.sendJson(res, 200, { logs, count: logs.length });
        return;
      }

      // ─── Streamable HTTP JSON-RPC 2.0 MCP Forward Proxy ────────────
      if (req.method === 'POST' && (pathname === '/mcp' || pathname === '/api/v1/mcp')) {
        const jsonRpc = await this.parseJsonBody(req);
        const callerDid = (req.headers['x-acr-agent-did'] as string) || 'did:key:agent-mcp-client';
        const callerRole = (req.headers['x-acr-role'] as any) || 'agent';

        if (jsonRpc.method === 'initialize') {
          this.sendJson(res, 200, {
            jsonrpc: '2.0',
            id: jsonRpc.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: 'acr-meta-mcp-proxy', version: '1.0.0' },
            },
          });
          return;
        }

        if (jsonRpc.method === 'tools/list') {
          const projected = this.service.getProjectedCatalog({ did: callerDid, role: callerRole });
          this.sendJson(res, 200, {
            jsonrpc: '2.0',
            id: jsonRpc.id,
            result: { tools: projected.tools },
          });
          return;
        }

        if (jsonRpc.method === 'tools/call') {
          const toolName = jsonRpc.params?.name;
          const args = (jsonRpc.params?.arguments as any) || {};
          const execution = await this.service.executeToolCall({ did: callerDid, role: callerRole }, toolName, args);

          if (execution.status === 'SUCCESS') {
            this.sendJson(res, 200, {
              jsonrpc: '2.0',
              id: jsonRpc.id,
              result: execution.result,
            });
          } else {
            this.sendJson(res, 200, {
              jsonrpc: '2.0',
              id: jsonRpc.id,
              error: {
                code: execution.status === 'DENIED' ? -32003 : -32603,
                message: execution.result?.error || 'Tool execution failed under policy',
              },
            });
          }
          return;
        }

        this.sendJson(res, 200, {
          jsonrpc: '2.0',
          id: jsonRpc.id,
          error: { code: -32601, message: `Method "${jsonRpc.method}" not implemented on Meta-MCP gateway.` },
        });
        return;
      }

      // Not found
      this.sendJson(res, 404, { error: `Endpoint "${pathname}" not found on ACR Meta-MCP Control Plane.` });
    } catch (err: any) {
      console.error('Server error in handleRequest:', err);
      this.sendJson(res, 500, { error: err.message, stack: err.stack });
    }
  }

  public async start(options: ServerOptions = {}): Promise<void> {
    const port = options.port || 20445;
    const host = options.host || '127.0.0.1';
    this.apiToken = (options.apiToken ?? process.env.ACR_META_MCP_API_TOKEN ?? '').trim();
    this.extraAllowedOrigins = options.allowedOrigins ?? (process.env.ACR_META_MCP_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    this.extraAllowedHosts = options.allowedHosts ?? (process.env.ACR_META_MCP_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (host && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      this.extraAllowedHosts.push(host);
    }

    this.httpServer = createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve) => {
      this.httpServer!.listen(port, host, () => {
        console.log(`[ACR Meta-MCP] Forward Proxy & Control Plane listening on http://${host}:${port}`);
        console.log(`[ACR Meta-MCP] JSON-RPC Gateway: http://${host}:${port}/mcp`);
        console.log(`[ACR Meta-MCP] REST API Surface: http://${host}:${port}/api/v1/meta-mcp/`);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
    await this.service.bridge.disconnectAll();
  }
}
