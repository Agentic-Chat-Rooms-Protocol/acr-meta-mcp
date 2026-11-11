import {
  JsonRpcRequest,
  JsonRpcResponse,
  McpCancellationNotification,
  McpClientAdapter,
  McpToolInvocationResult,
} from './types.js';

export interface HttpAdapterOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  transportSendFn?: (req: JsonRpcRequest, signal: AbortSignal) => Promise<JsonRpcResponse>;
}

export class HttpMcpAdapter implements McpClientAdapter {
  private connected = false;
  private reqIdCounter = 1;
  private readonly inFlightControllers = new Map<string | number, AbortController>();
  private readonly emittedNotifications: McpCancellationNotification[] = [];
  private dispatchAttemptCount = 0;

  constructor(private readonly options: HttpAdapterOptions) {}

  public async connect(): Promise<void> {
    this.connected = true;
  }

  public async cancelRequest(
    requestId: string | number,
    reason = 'Operator or caller cancelled in-flight MCP tool call'
  ): Promise<McpCancellationNotification> {
    const notification: McpCancellationNotification = {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: {
        requestId,
        reason,
      },
    };
    this.emittedNotifications.push(notification);

    const controller = this.inFlightControllers.get(requestId);
    if (controller) {
      controller.abort(new Error(`MCP_REQUEST_CANCELLED:${reason}`));
      this.inFlightControllers.delete(requestId);
    }

    return notification;
  }

  public getEmittedNotifications(): McpCancellationNotification[] {
    return [...this.emittedNotifications];
  }

  public getDispatchAttemptCount(): number {
    return this.dispatchAttemptCount;
  }

  public async sendRequest(
    method: string,
    params?: Record<string, unknown>,
    externalSignal?: AbortSignal,
    explicitId?: string | number
  ): Promise<any> {
    const id = explicitId ?? this.reqIdCounter++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'ACR-Meta-MCP-Proxy/0.8.2',
      ...(this.options.headers || {}),
    };

    const controller = new AbortController();
    this.inFlightControllers.set(id, controller);

    const onExternalAbort = () => {
      void this.cancelRequest(id, String(externalSignal?.reason || 'Aborted via signal'));
    };
    if (externalSignal) {
      if (externalSignal.aborted) {
        onExternalAbort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs || 25000);

    try {
      this.dispatchAttemptCount += 1;

      if (this.options.transportSendFn) {
        const json = await this.options.transportSendFn(req, controller.signal);
        if (json.error) {
          throw new Error(`Remote MCP Error [${json.error.code}]: ${json.error.message}`);
        }
        return json.result;
      }

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
      this.inFlightControllers.delete(id);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
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

  public async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean }> {
    const res = await this.sendRequest('tools/call', { name, arguments: args });
    return res || { content: [{ type: 'text', text: 'Success' }] };
  }

  /**
   * Experiment 1: Executes a tool call with explicit cancellation & transport interruption handling.
   * Never performs silent retries of side-effecting tool calls (`retryAttempted: false`).
   * Reports truthful `OUTCOME_UNKNOWN` when cancelled during a transport interruption after dispatch.
   */
  public async callToolWithSignal(
    name: string,
    args: Record<string, unknown>,
    options: {
      signal?: AbortSignal;
      requestId?: string | number;
      cancelReason?: string;
    } = {}
  ): Promise<McpToolInvocationResult> {
    const requestId = options.requestId ?? this.reqIdCounter++;

    if (options.signal?.aborted) {
      await this.cancelRequest(requestId, options.cancelReason ?? 'Cancelled prior to dispatch');
      return {
        requestId,
        status: 'CANCELLED',
        retryAttempted: false,
        attemptCount: 0,
        cancellationSent: true,
        content: [{ type: 'text', text: 'Tool call cancelled prior to dispatch' }],
        isError: true,
        terminalReason: 'cancelled_before_dispatch',
      };
    }

    const attemptsBefore = this.dispatchAttemptCount;
    try {
      const res = await this.sendRequest('tools/call', { name, arguments: args }, options.signal, requestId);
      const attemptsTaken = this.dispatchAttemptCount - attemptsBefore;
      return {
        requestId,
        status: 'COMPLETED',
        retryAttempted: false,
        attemptCount: attemptsTaken,
        cancellationSent: false,
        content: res?.content || [{ type: 'text', text: 'Success' }],
        isError: false,
      };
    } catch (err: any) {
      const attemptsTaken = this.dispatchAttemptCount - attemptsBefore;
      const alreadyCancelled = this.emittedNotifications.some((n) => n.params.requestId === requestId);
      if (!alreadyCancelled && options.signal?.aborted) {
        await this.cancelRequest(requestId, options.cancelReason ?? 'Cancelled during transport interruption');
      }
      const cancellationSent = this.emittedNotifications.some((n) => n.params.requestId === requestId);
      const errMsg = err?.message || String(err);
      const isTransportOrAbort =
        cancellationSent ||
        err?.name === 'AbortError' ||
        errMsg.includes('MCP_REQUEST_CANCELLED') ||
        errMsg.includes('transport') ||
        errMsg.includes('ECONNRESET') ||
        errMsg.includes('socket hang up');

      // Because request was already dispatched over the wire when interrupted/cancelled,
      // the side effect may or may not have completed on the remote tool server -> OUTCOME_UNKNOWN!
      return {
        requestId,
        status: isTransportOrAbort ? 'OUTCOME_UNKNOWN' : 'FAILED',
        retryAttempted: false,
        attemptCount: attemptsTaken,
        cancellationSent,
        content: [{ type: 'text', text: errMsg }],
        isError: true,
        terminalReason: isTransportOrAbort
          ? 'cancelled_during_transport_interruption_outcome_unknown'
          : errMsg,
      };
    }
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
  }

  public isConnected(): boolean {
    return this.connected;
  }
}

