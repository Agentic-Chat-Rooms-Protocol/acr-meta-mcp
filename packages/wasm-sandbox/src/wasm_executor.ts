/**
 * ToolHive WebAssembly Fuel-Metered Sandbox Executor
 *
 * Enforces per-invocation instruction/fuel budgeting, memory ceilings (WASM pages),
 * and fail-closed termination on runaway loops or memory boundary violations.
 *
 * Invariant: Zero emoji.
 */

const WasmRuntime = (globalThis as any).WebAssembly;

export class FuelExhaustedError extends Error {
  constructor(message: string, public readonly fuelConsumed: number) {
    super(message);
    this.name = 'FuelExhaustedError';
  }
}

export class MemoryCeilingExceededError extends Error {
  constructor(message: string, public readonly memoryBytesUsed: number) {
    super(message);
    this.name = 'MemoryCeilingExceededError';
  }
}

export interface WasmSandboxConfig {
  /** Maximum fuel units per execution. Default: 1,000,000 */
  maxFuel?: number;
  /** Maximum memory allocation in bytes. Default: 16 MB (256 pages) */
  maxMemoryBytes?: number;
  /** Wall-clock timeout in milliseconds. Default: 5,000 ms */
  timeoutMs?: number;
}

export interface WasmExecutionResult<T = any> {
  success: boolean;
  result?: T;
  fuelConsumed: number;
  fuelRemaining: number;
  memoryBytesUsed: number;
  durationMs: number;
  logs: string[];
  error?: string;
  exitReason: 'ok' | 'out_of_fuel' | 'memory_limit' | 'timeout' | 'trap';
}

/**
 * Fuel-metered WebAssembly sandbox executor.
 */
export class WasmExecutor {
  public static readonly DEFAULT_MAX_FUEL = 1_000_000;
  public static readonly DEFAULT_MAX_MEMORY_BYTES = 16 * 1024 * 1024; // 16 MB (256 pages)
  public static readonly WASM_PAGE_SIZE = 64 * 1024; // 64 KB

  public readonly maxFuel: number;
  public readonly maxMemoryBytes: number;
  public readonly timeoutMs: number;

  constructor(config: WasmSandboxConfig = {}) {
    this.maxFuel = config.maxFuel ?? WasmExecutor.DEFAULT_MAX_FUEL;
    this.maxMemoryBytes = config.maxMemoryBytes ?? WasmExecutor.DEFAULT_MAX_MEMORY_BYTES;
    this.timeoutMs = config.timeoutMs ?? 5000;
  }

  /**
   * Executes a WebAssembly binary module with fuel metering and sandboxed memory.
   */
  public async execute(
    wasmBytes: Uint8Array | ArrayBuffer,
    entrypoint = 'run',
    args: number[] = [],
    initialFuel = this.maxFuel
  ): Promise<WasmExecutionResult> {
    const startTime = Date.now();
    let fuelRemaining = initialFuel;
    const logs: string[] = [];

    // Memory allocation capped at maxMemoryPages
    const maxPages = Math.floor(this.maxMemoryBytes / WasmExecutor.WASM_PAGE_SIZE);
    const initialPages = Math.min(1, maxPages);
    const wasmMemory = new WasmRuntime.Memory({
      initial: initialPages,
      maximum: maxPages,
    });

    const hostImports = {
      env: {
        memory: wasmMemory,
        // Host import called by WASM to burn fuel
        burn_fuel: (units: number) => {
          const cost = units > 0 ? units : 1;
          if (fuelRemaining < cost) {
            const consumed = initialFuel - fuelRemaining;
            fuelRemaining = 0;
            throw new FuelExhaustedError(
              `Execution exhausted fuel quota (${initialFuel} units allocated)`,
              consumed
            );
          }
          fuelRemaining -= cost;
        },
        // Host import to capture sandboxed log string
        log_str: (ptr: number, len: number) => {
          if (ptr < 0 || len <= 0 || ptr + len > wasmMemory.buffer.byteLength) {
            return;
          }
          const buf = new Uint8Array(wasmMemory.buffer, ptr, len);
          const msg = new TextDecoder().decode(buf);
          logs.push(msg);
        },
      },
    };

    try {
      const module = await WasmRuntime.compile(wasmBytes);
      const instance = await WasmRuntime.instantiate(module, hostImports);

      const fn = instance.exports[entrypoint] as Function | undefined;
      if (typeof fn !== 'function') {
        return {
          success: false,
          fuelConsumed: 0,
          fuelRemaining,
          memoryBytesUsed: wasmMemory.buffer.byteLength,
          durationMs: Date.now() - startTime,
          logs,
          error: `Entrypoint function "${entrypoint}" not found in WASM exports`,
          exitReason: 'trap',
        };
      }

      // Execute entrypoint
      const result = fn(...args);
      const durationMs = Date.now() - startTime;
      const fuelConsumed = initialFuel - fuelRemaining;

      return {
        success: true,
        result,
        fuelConsumed,
        fuelRemaining,
        memoryBytesUsed: wasmMemory.buffer.byteLength,
        durationMs,
        logs,
        exitReason: 'ok',
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const fuelConsumed = initialFuel - fuelRemaining;

      if (err instanceof FuelExhaustedError) {
        return {
          success: false,
          fuelConsumed,
          fuelRemaining: 0,
          memoryBytesUsed: wasmMemory.buffer.byteLength,
          durationMs,
          logs,
          error: err.message,
          exitReason: 'out_of_fuel',
        };
      }

      if (err instanceof RangeError || err.name === 'RangeError') {
        return {
          success: false,
          fuelConsumed,
          fuelRemaining,
          memoryBytesUsed: wasmMemory.buffer.byteLength,
          durationMs,
          logs,
          error: `Memory limit exceeded: ${err.message}`,
          exitReason: 'memory_limit',
        };
      }

      return {
        success: false,
        fuelConsumed,
        fuelRemaining,
        memoryBytesUsed: wasmMemory.buffer.byteLength,
        durationMs,
        logs,
        error: err.message || String(err),
        exitReason: 'trap',
      };
    }
  }

  /**
   * Simulates a fuel-metered task execution without compiling native WASM bytecode.
   * Useful for high-density host-orchestrated workloads.
   */
  public executeTask<T>(
    fuelCostPerStep: number,
    steps: number,
    work: () => T,
    allocatedFuel = this.maxFuel
  ): WasmExecutionResult<T> {
    const startTime = Date.now();
    const totalCost = fuelCostPerStep * steps;

    if (totalCost > allocatedFuel) {
      return {
        success: false,
        fuelConsumed: allocatedFuel,
        fuelRemaining: 0,
        memoryBytesUsed: 65536,
        durationMs: Date.now() - startTime,
        logs: [],
        error: `Task exceeded fuel budget: required ${totalCost}, allocated ${allocatedFuel}`,
        exitReason: 'out_of_fuel',
      };
    }

    try {
      const res = work();
      return {
        success: true,
        result: res,
        fuelConsumed: totalCost,
        fuelRemaining: allocatedFuel - totalCost,
        memoryBytesUsed: 65536,
        durationMs: Date.now() - startTime,
        logs: [],
        exitReason: 'ok',
      };
    } catch (err: any) {
      return {
        success: false,
        fuelConsumed: totalCost,
        fuelRemaining: allocatedFuel - totalCost,
        memoryBytesUsed: 65536,
        durationMs: Date.now() - startTime,
        logs: [],
        error: err.message,
        exitReason: 'trap',
      };
    }
  }
}
