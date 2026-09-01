import { JsonRpcRequest, JsonRpcResponse, McpClientAdapter } from './types.js';

export interface HttpAdapterOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class HttpMcpAdapter implements McpClientAdapter {
  private connected = false;
  private reqIdCounter = 1;

  constructor(private readonly options: HttpAdapterOptions) {}

  public async connect(): Promise<void> {
    this.connected = true;
  }

  public async sendRequest(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = this.reqIdCounter++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'ACR-Meta-MCP-Proxy/0.8.2',
      ...(this.options.headers || {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs || 25000);

    try {
      const resp = await fetch(this.options.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }

      const json = (await resp.json()) as JsonRpcResponse;
      if (json.error) {
        throw new Error(`Remote MCP Error [${json.error.code}]: ${json.error.message}`);
      }

      return json.result;
    } finally {
      clearTimeout(timeout);
    }
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
    this.connected = false;
  }

  public isConnected(): boolean {
    return this.connected;
  }
}
