import { HttpMcpAdapter } from './http-adapter.js';
import { StdioMcpAdapter } from './stdio-adapter.js';
import { McpClientAdapter } from './types.js';

export interface ServerConnectionSpec {
  serverId: string;
  transport: 'stdio' | 'sse' | 'streamable_http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  sandboxProfile?: any;
}

export class TransportBridge {
  private readonly adapters = new Map<string, McpClientAdapter>();

  public getOrCreateAdapter(spec: ServerConnectionSpec): McpClientAdapter {
    const existing = this.adapters.get(spec.serverId);
    if (existing && existing.isConnected()) {
      return existing;
    }

    let adapter: McpClientAdapter;

    if (spec.transport === 'stdio') {
      if (!spec.command) {
        throw new Error(`Cannot create Stdio adapter for "${spec.serverId}": missing command.`);
      }
      adapter = new StdioMcpAdapter({
        command: spec.command,
        args: spec.args,
        env: spec.env,
        policy: spec.sandboxProfile,
      });
    } else {
      if (!spec.url) {
        throw new Error(`Cannot create HTTP adapter for "${spec.serverId}": missing url.`);
      }
      adapter = new HttpMcpAdapter({
        url: spec.url,
        headers: spec.headers,
      });
    }

    this.adapters.set(spec.serverId, adapter);
    return adapter;
  }

  public async forwardToolCall(
    spec: ServerConnectionSpec,
    originalToolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean }> {
    const adapter = this.getOrCreateAdapter(spec);
    if (!adapter.isConnected()) {
      await adapter.connect();
    }
    return adapter.callTool(originalToolName, args);
  }

  public async forwardListTools(
    spec: ServerConnectionSpec
  ): Promise<Array<{ name: string; description?: string; inputSchema?: any }>> {
    const adapter = this.getOrCreateAdapter(spec);
    if (!adapter.isConnected()) {
      await adapter.connect();
    }
    return adapter.listTools();
  }

  public async disconnectAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.disconnect();
      } catch {
        // Ignore disconnect errors during batch shutdown
      }
    }
    this.adapters.clear();
  }
}
