import { SandboxedProcess, SandboxPolicyConfig } from '../../sandbox-runtime/src/index.js';
import { JsonRpcRequest, JsonRpcResponse, McpClientAdapter } from './types.js';

export interface StdioAdapterOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  policy?: SandboxPolicyConfig;
}

export class StdioMcpAdapter implements McpClientAdapter {
  private sandboxProcess: SandboxedProcess | null = null;
  private connected = false;
  private reqIdCounter = 1;
  private pendingRequests = new Map<string | number, { resolve: (res: any) => void; reject: (err: any) => void }>();
  private buffer = '';

  constructor(private readonly options: StdioAdapterOptions) {}

  public async connect(): Promise<void> {
    const policy: SandboxPolicyConfig = this.options.policy || {
      profile: 'workspace-scoped',
      maxMemoryMb: 512,
      timeoutMs: 30000,
    };

    this.sandboxProcess = new SandboxedProcess({
      command: this.options.command,
      args: this.options.args || [],
      env: this.options.env || {},
      policy,
    });

    const child = this.sandboxProcess.spawn();
    this.connected = true;

    child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    child.on('close', () => {
      this.connected = false;
    });

    // Send standard initialize request
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'acr-meta-mcp-proxy', version: '0.8.2' },
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as JsonRpcResponse;
        if (parsed.id !== undefined && this.pendingRequests.has(parsed.id)) {
          const handler = this.pendingRequests.get(parsed.id)!;
          this.pendingRequests.delete(parsed.id);
          if (parsed.error) {
            handler.reject(new Error(`MCP Error [${parsed.error.code}]: ${parsed.error.message}`));
          } else {
            handler.resolve(parsed.result);
          }
        }
      } catch {
        // Non-JSON logging line from child process
      }
    }
  }

  public async sendRequest(method: string, params?: Record<string, unknown>): Promise<any> {
    if (!this.connected || !this.sandboxProcess?.process) {
      throw new Error('StdioMcpAdapter is not connected.');
    }

    const id = this.reqIdCounter++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.sandboxProcess!.process!.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  public async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: any }>> {
    try {
      const res = await this.sendRequest('tools/list', {});
      return res?.tools || [];
    } catch {
      return [];
    }
  }

  public async callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean }> {
    const res = await this.sendRequest('tools/call', { name, arguments: args });
    return res || { content: [{ type: 'text', text: 'Success' }] };
  }

  public async disconnect(): Promise<void> {
    if (this.sandboxProcess) {
      this.sandboxProcess.kill();
      this.sandboxProcess = null;
    }
    this.connected = false;
  }

  public isConnected(): boolean {
    return this.connected;
  }
}
