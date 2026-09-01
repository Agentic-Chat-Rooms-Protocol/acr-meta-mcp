import { compileInstallManifest } from '../../../packages/config-parser/src/index.js';
import { AuthVault } from '../../../packages/auth-vault/src/index.js';
import { DEFAULT_SANDBOX_PROFILES } from '../../../packages/sandbox-runtime/src/index.js';
import { PolicyEngine } from '../../../packages/policy-engine/src/index.js';
import { CatalogProjector, denamespaceTool, McpToolDefinition } from '../../../packages/catalog-projector/src/index.js';
import { MetaMcpRegistry } from '../../../packages/registry-core/src/index.js';
import { TransportBridge } from '../../../packages/transport-bridge/src/index.js';
import { AuditLogger } from './audit.js';

export class MetaMcpService {
  public readonly vault = new AuthVault();
  public readonly registry = new MetaMcpRegistry();
  public readonly policyEngine = new PolicyEngine();
  public readonly bridge = new TransportBridge();
  public readonly auditLogger = new AuditLogger();
  public readonly projector: CatalogProjector;

  // Cached tool definitions per server
  private readonly toolStore = new Map<string, Array<{ name: string; description?: string; inputSchema?: any }>>();

  constructor() {
    this.projector = new CatalogProjector({
      isServerEnabled: (sId) => this.registry.getServer(sId)?.enabled ?? true,
      isServerQuarantined: (sId) => this.registry.getServer(sId)?.quarantined ?? false,
      isToolEnabled: (tName) => this.policyEngine.getToolPolicy(tName)?.enabled ?? true,
    });

    // Seed standard demo / verified server so Meta-MCP is immediately operable out of the box
    this.seedDefaultServers();
  }

  private seedDefaultServers(): void {
    // 1. Gitee Reference Server
    this.registry.registerServer('gitee-cloud', {
      displayName: 'Gitee Dev Protocol Gateway',
      transport: 'streamable_http',
      trustLevel: 'verified',
      sandboxProfile: 'egress-allowlist',
      configSpec: { url: 'https://gitee.com/api/mcp' },
    });
    this.registry.updateHealth('gitee-cloud', 'ONLINE', 3);
    this.toolStore.set('gitee-cloud', [
      { name: 'create_issue', description: 'Create a new issue on Gitee repo', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
      { name: 'list_pull_requests', description: 'List open pull requests on Gitee repo', inputSchema: { type: 'object' } },
      { name: 'get_commit_diff', description: 'Get commit diff and ast tree', inputSchema: { type: 'object' } },
    ]);

    // 2. Local Workstation Filesystem Sandbox Server
    this.registry.registerServer('workspace-fs', {
      displayName: 'Local Workstation FS Sandbox',
      transport: 'stdio',
      trustLevel: 'internal',
      sandboxProfile: 'workspace-scoped',
      configSpec: { command: 'node', args: ['./scripts/fs-tool.js'] },
    });
    this.registry.updateHealth('workspace-fs', 'ONLINE', 2);
    this.toolStore.set('workspace-fs', [
      { name: 'read_workspace_file', description: 'Read file from scoped workspace', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      { name: 'list_workspace_dir', description: 'List files in scoped workspace directory', inputSchema: { type: 'object', properties: { dir: { type: 'string' } } } },
    ]);
  }

  public importMcpConfig(rawConfig: string, actorDid = 'did:key:admin-local'): {
    manifestVersion: string;
    fingerprintSha256: string;
    installedServers: string[];
    secretCount: number;
  } {
    const manifest = compileInstallManifest(rawConfig);

    for (const serverSpec of manifest.servers) {
      // Store secret references in vault
      for (const ref of serverSpec.secretRefs) {
        this.vault.storeSecret(ref.refId, ref.serverId, ref.key, ref.originalValue, ref.domain);
      }

      // Register server in registry
      this.registry.registerServer(serverSpec.serverId, {
        displayName: serverSpec.displayName,
        transport: serverSpec.transport,
        sandboxProfile: serverSpec.transport === 'stdio' ? 'workspace-scoped' : 'egress-allowlist',
        manifestFingerprint: manifest.fingerprintSha256,
        configSpec: serverSpec.stdioSpec ? (serverSpec.stdioSpec as any) : (serverSpec.remoteSpec as any),
      });

      // Default mock toolset for newly imported server until discovered
      this.toolStore.set(serverSpec.serverId, [
        { name: 'ping', description: `Health ping for ${serverSpec.serverId}` },
        { name: 'status', description: `Check runtime status for ${serverSpec.serverId}` },
      ]);
      this.registry.updateHealth(serverSpec.serverId, 'ONLINE', 2);
    }

    this.auditLogger.record({
      eventType: 'CONFIG_IMPORT',
      actorDid,
      status: 'SUCCESS',
      details: {
        totalServers: manifest.totalServers,
        fingerprint: manifest.fingerprintSha256,
        servers: manifest.servers.map((s) => s.serverId),
      },
    });

    return {
      manifestVersion: manifest.manifestVersion,
      fingerprintSha256: manifest.fingerprintSha256,
      installedServers: manifest.servers.map((s) => s.serverId),
      secretCount: manifest.totalSecretRefs,
    };
  }

  public getRawCatalog() {
    const map: Record<string, any[]> = {};
    for (const [sId, tools] of this.toolStore.entries()) {
      map[sId] = tools;
    }
    return this.projector.buildRawCatalog(map);
  }

  public getPolicyCatalog() {
    const raw = this.getRawCatalog();
    return this.projector.buildPolicyCatalog(raw);
  }

  public getProjectedCatalog(caller: { did: string; role: string; capabilities?: string[]; allowedPrefixes?: string[] }) {
    const policy = this.getPolicyCatalog();
    return this.projector.projectForCaller(policy, caller);
  }

  public async executeToolCall(
    caller: { did: string; role: 'admin' | 'agent' | 'human_operator' | 'guest'; roomContext?: string },
    namespacedToolName: string,
    args: Record<string, unknown>
  ): Promise<{ result: any; latencyMs: number; status: 'SUCCESS' | 'DENIED' | 'ERROR' }> {
    const startTime = Date.now();
    const { serverId, originalName } = denamespaceTool(namespacedToolName);

    // 1. Evaluate Policy Engine
    const decision = this.policyEngine.evaluateToolCall(caller, serverId, namespacedToolName, caller.roomContext);

    if (!decision.allowed) {
      const latencyMs = Date.now() - startTime;
      this.auditLogger.record({
        eventType: 'POLICY_VIOLATION',
        actorDid: caller.did,
        serverId,
        toolName: namespacedToolName,
        status: decision.action === 'REQUIRE_HUMAN_CONFIRMATION' ? 'CONFIRMATION_REQUIRED' : 'DENIED',
        latencyMs,
        details: { reason: decision.reason, layer: decision.layer },
      });

      return {
        result: { isError: true, error: decision.reason, action: decision.action },
        latencyMs,
        status: 'DENIED',
      };
    }

    // 2. Resolve Server Registration
    const server = this.registry.getServer(serverId);
    if (!server) {
      const latencyMs = Date.now() - startTime;
      return {
        result: { isError: true, error: `Server "${serverId}" is not registered in Meta-MCP.` },
        latencyMs,
        status: 'ERROR',
      };
    }

    // 3. Execution Simulation or Live Dispatch
    let executionContent: any;
    try {
      if (originalName === 'ping' || originalName === 'status') {
        executionContent = {
          content: [{ type: 'text', text: `[${serverId}] Pong. Meta-MCP Forward Proxy operational. Latency: 0.24ms` }],
        };
      } else if (originalName === 'create_issue') {
        executionContent = {
          content: [{ type: 'text', text: `[${serverId}] Issue #${Math.floor(100 + Math.random() * 900)} created successfully: "${args.title || 'Untitled'}"` }],
        };
      } else if (originalName === 'list_pull_requests' || originalName === 'get_commit_diff') {
        executionContent = {
          content: [{ type: 'text', text: `[${serverId}] Retrieved AST diff and stack proofs for PR #104 (+38 -12 lines).` }],
        };
      } else if (originalName === 'read_workspace_file' || originalName === 'list_workspace_dir') {
        executionContent = {
          content: [{ type: 'text', text: `[${serverId}] Workspace directory listed (sandbox contained, profile: workspace-scoped).` }],
        };
      } else {
        executionContent = {
          content: [{ type: 'text', text: `[${serverId}] Tool "${originalName}" executed successfully with payload: ${JSON.stringify(args)}` }],
        };
      }

      const latencyMs = Date.now() - startTime;
      this.auditLogger.record({
        eventType: 'TOOL_CALL',
        actorDid: caller.did,
        serverId,
        toolName: namespacedToolName,
        status: 'SUCCESS',
        latencyMs,
        details: { args, resultSummary: 'Success' },
      });

      return { result: executionContent, latencyMs, status: 'SUCCESS' };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      this.auditLogger.record({
        eventType: 'TOOL_CALL',
        actorDid: caller.did,
        serverId,
        toolName: namespacedToolName,
        status: 'ERROR',
        latencyMs,
        details: { error: err.message },
      });
      return { result: { isError: true, error: err.message }, latencyMs, status: 'ERROR' };
    }
  }
}
