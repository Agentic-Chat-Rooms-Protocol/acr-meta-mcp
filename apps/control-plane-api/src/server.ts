import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { MetaMcpService } from './service.js';

export interface ServerOptions {
  port?: number;
  host?: string;
}

export class MetaMcpServer {
  public readonly service = new MetaMcpService();
  private httpServer: Server | null = null;

  private setCorsAndPnaHeaders(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-ACR-Agent-DID, X-ACR-Role');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    // Private Network Access (PNA) header for HTTPS -> localhost
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
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
    this.setCorsAndPnaHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      // ─── Health check ──────────────────────────────────────────────
      if (req.method === 'GET' && (pathname === '/health' || pathname === '/api/v1/meta-mcp/health')) {
        this.sendJson(res, 200, {
          status: 'ONLINE',
          version: '0.8.2',
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
        this.sendJson(res, result.status === 'SUCCESS' ? 200 : (result.status === 'DENIED' ? 403 : 500), result);
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
              serverInfo: { name: 'acr-meta-mcp-proxy', version: '0.8.2' },
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
      this.sendJson(res, 500, { error: err.message });
    }
  }

  public async start(options: ServerOptions = {}): Promise<void> {
    const port = options.port || 20445;
    const host = options.host || '0.0.0.0';

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
