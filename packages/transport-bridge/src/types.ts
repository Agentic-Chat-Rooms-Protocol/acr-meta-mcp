export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface McpCancellationNotification extends JsonRpcNotification {
  method: 'notifications/cancelled';
  params: {
    requestId: string | number;
    reason?: string;
  };
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type ToolCallOutcomeState =
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'OUTCOME_UNKNOWN';

export interface McpToolInvocationResult {
  requestId: string | number;
  status: ToolCallOutcomeState;
  retryAttempted: false;
  attemptCount: number;
  cancellationSent: boolean;
  content: Array<{ type: string; text?: string; data?: string }>;
  isError?: boolean;
  terminalReason?: string;
}

export interface McpClientAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: any }>>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean }>;
  isConnected(): boolean;
}

