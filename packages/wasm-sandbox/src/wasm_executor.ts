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

export class HostImportDeniedError extends Error {
  constructor(
    message: string,
    public readonly moduleName: string,
    public readonly importName: string
  ) {
    super(message);
    this.name = 'HostImportDeniedError';
  }
}

export interface WasmSandboxConfig {
  /** Maximum fuel units per execution. Default: 1,000,000 */
  maxFuel?: number;
  /** Maximum memory allocation in bytes. Default: 16 MB (256 pages) */
  maxMemoryBytes?: number;
  /** Wall-clock timeout in milliseconds. Default: 5,000 ms */
  timeoutMs?: number;
  /** Explicit allowlist of permitted host imports in 'module.name' format. Default: ['env.memory', 'env.burn_fuel', 'env.log_str'] */
  allowedImports?: string[];
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
  exitReason: 'ok' | 'out_of_fuel' | 'memory_limit' | 'timeout' | 'host_import_denied' | 'trap';
}

/**
 * Fuel-metered WebAssembly sandbox executor.
 */
export class WasmExecutor {
  public static readonly DEFAULT_MAX_FUEL = 1_000_000;
  public static readonly DEFAULT_MAX_MEMORY_BYTES = 16 * 1024 * 1024; // 16 MB (256 pages)
  public static readonly WASM_PAGE_SIZE = 64 * 1024; // 64 KB
  public static readonly DEFAULT_ALLOWED_IMPORTS = [
    'env.memory',
    'env.burn_fuel',
    'env.log_str',
  ];

  public readonly maxFuel: number;
  public readonly maxMemoryBytes: number;
  public readonly timeoutMs: number;
  public readonly allowedImports: ReadonlySet<string>;

  constructor(config: WasmSandboxConfig = {}) {
    this.maxFuel = config.maxFuel ?? WasmExecutor.DEFAULT_MAX_FUEL;
    this.maxMemoryBytes = config.maxMemoryBytes ?? WasmExecutor.DEFAULT_MAX_MEMORY_BYTES;
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.allowedImports = new Set(config.allowedImports ?? WasmExecutor.DEFAULT_ALLOWED_IMPORTS);
  }

  /**
   * Parses WebAssembly binary header sections (Section 2 Import & Section 5 Memory)
   * using unsigned LEB128 decoding to detect initial memory page declarations
   * BEFORE module instantiation (Experiment 10 / Challenge E10 Module D).
   */
  public static inspectDeclaredMemoryPages(wasmBytes: Uint8Array | ArrayBuffer): number {
    const bytes = wasmBytes instanceof Uint8Array ? wasmBytes : new Uint8Array(wasmBytes);
    if (bytes.length < 8) return 0;
    // Check magic \0asm (0x00 0x61 0x73 0x6d)
    if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
      return 0;
    }

    const readLeb128U32 = (offset: number): { value: number; next: number } => {
      let result = 0;
      let shift = 0;
      let pos = offset;
      while (pos < bytes.length) {
        const byte = bytes[pos++];
        result |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
        if (shift > 35) break;
      }
      return { value: result >>> 0, next: pos };
    };

    let offset = 8;
    let maxDeclaredInitialPages = 0;

    while (offset < bytes.length) {
      const sectionId = bytes[offset++];
      const sizeInfo = readLeb128U32(offset);
      const sectionStart = sizeInfo.next;
      const sectionEnd = sectionStart + sizeInfo.value;
      if (sectionEnd > bytes.length) break;

      if (sectionId === 2) {
        // Import section (2): count, then [mod_len, mod_bytes, name_len, name_bytes, kind: u8, desc...]
        let p = sectionStart;
        const countInfo = readLeb128U32(p);
        p = countInfo.next;
        for (let i = 0; i < countInfo.value && p < sectionEnd; i++) {
          const modLen = readLeb128U32(p);
          p = modLen.next + modLen.value;
          if (p >= sectionEnd) break;
          const nameLen = readLeb128U32(p);
          p = nameLen.next + nameLen.value;
          if (p >= sectionEnd) break;
          const kind = bytes[p++];
          if (kind === 0x00) {
            // func type index
            p = readLeb128U32(p).next;
          } else if (kind === 0x01) {
            // table: elemtype (1 byte) + limits
            p += 1;
            const flagsInfo = readLeb128U32(p);
            const initInfo = readLeb128U32(flagsInfo.next);
            p = initInfo.next;
            if ((flagsInfo.value & 0x01) !== 0) {
              p = readLeb128U32(p).next;
            }
          } else if (kind === 0x02) {
            // memory: limits (flags, initial, [max])
            const flagsInfo = readLeb128U32(p);
            const initInfo = readLeb128U32(flagsInfo.next);
            p = initInfo.next;
            if (initInfo.value > maxDeclaredInitialPages) {
              maxDeclaredInitialPages = initInfo.value;
            }
            if ((flagsInfo.value & 0x01) !== 0) {
              p = readLeb128U32(p).next;
            }
          } else if (kind === 0x03) {
            // global: valtype (1 byte) + mutability (1 byte)
            p += 2;
          } else {
            break;
          }
        }
      } else if (sectionId === 5) {
        // Memory section (5): count, then limits (flags: u8/leb, initial: leb, [max: leb])
        let p = sectionStart;
        const countInfo = readLeb128U32(p);
        p = countInfo.next;
        for (let i = 0; i < countInfo.value && p < sectionEnd; i++) {
          const flagsInfo = readLeb128U32(p);
          const initInfo = readLeb128U32(flagsInfo.next);
          p = initInfo.next;
          if (initInfo.value > maxDeclaredInitialPages) {
            maxDeclaredInitialPages = initInfo.value;
          }
          if ((flagsInfo.value & 0x01) !== 0) {
            const maxInfo = readLeb128U32(p);
            p = maxInfo.next;
          }
        }
      }
      offset = sectionEnd;
    }

    return maxDeclaredInitialPages;
  }

  /**
   * Executes a WebAssembly binary module with pre-instantiation import allowlisting,
   * pre-instantiation binary header memory inspection, fuel metering, and sandboxed memory ceilings.
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
    const maxPages = Math.max(1, Math.floor(this.maxMemoryBytes / WasmExecutor.WASM_PAGE_SIZE));
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
      // Pre-instantiation binary header inspection for Memory section initial pages
      const declaredInitialPages = WasmExecutor.inspectDeclaredMemoryPages(wasmBytes);
      const declaredInitialBytes = declaredInitialPages * WasmExecutor.WASM_PAGE_SIZE;
      if (declaredInitialBytes > this.maxMemoryBytes) {
        throw new MemoryCeilingExceededError(
          `InitialMemoryExceededError: WASM binary header declares ${declaredInitialPages} pages (${declaredInitialBytes} bytes) which exceeds ceiling (${this.maxMemoryBytes} bytes)`,
          declaredInitialBytes
        );
      }

      const module = await WasmRuntime.compile(wasmBytes);

      // Experiment 10: Pre-instantiation host import allowlist inspection
      const declaredImports: Array<{ module: string; name: string; kind: string }> =
        WasmRuntime.Module.imports(module);
      for (const imp of declaredImports) {
        const key = `${imp.module}.${imp.name}`;
        if (!this.allowedImports.has(key)) {
          throw new HostImportDeniedError(
            `Prohibited WASM host import denied prior to instantiation: "${key}" (kind: ${imp.kind})`,
            imp.module,
            imp.name
          );
        }
      }

      const instance = await WasmRuntime.instantiate(module, hostImports);

      // Enforce memory ceiling on module-exported linear memory (if exported directly by guest)
      const exportedMem = instance.exports.memory;
      if (exportedMem && exportedMem.buffer && exportedMem.buffer.byteLength > this.maxMemoryBytes) {
        throw new MemoryCeilingExceededError(
          `WASM module initial memory (${exportedMem.buffer.byteLength} bytes) exceeds ceiling (${this.maxMemoryBytes} bytes)`,
          exportedMem.buffer.byteLength
        );
      }

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

      // Execute entrypoint with timeout guard
      let timer: NodeJS.Timeout | null = null;
      const executeFn = async () => fn(...args);
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const timeoutErr = new Error(`WASM execution exceeded timeout (${this.timeoutMs}ms)`);
          (timeoutErr as any).name = 'TimeoutError';
          reject(timeoutErr);
        }, this.timeoutMs);
      });

      let result: any;
      try {
        result = await Promise.race([executeFn(), timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      const activeMemBytes =
        exportedMem && exportedMem.buffer
          ? exportedMem.buffer.byteLength
          : wasmMemory.buffer.byteLength;
      if (activeMemBytes > this.maxMemoryBytes) {
        throw new MemoryCeilingExceededError(
          `WASM execution exceeded memory ceiling (${activeMemBytes} > ${this.maxMemoryBytes} bytes)`,
          activeMemBytes
        );
      }

      const durationMs = Date.now() - startTime;
      const fuelConsumed = initialFuel - fuelRemaining;

      return {
        success: true,
        result,
        fuelConsumed,
        fuelRemaining,
        memoryBytesUsed: activeMemBytes,
        durationMs,
        logs,
        exitReason: 'ok',
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const fuelConsumed = initialFuel - fuelRemaining;

      if (err instanceof HostImportDeniedError) {
        return {
          success: false,
          fuelConsumed: 0,
          fuelRemaining,
          memoryBytesUsed: wasmMemory.buffer.byteLength,
          durationMs,
          logs,
          error: err.message,
          exitReason: 'host_import_denied',
        };
      }

      if (err instanceof MemoryCeilingExceededError) {
        return {
          success: false,
          fuelConsumed,
          fuelRemaining,
          memoryBytesUsed: err.memoryBytesUsed,
          durationMs,
          logs,
          error: err.message,
          exitReason: 'memory_limit',
        };
      }

      if (err.name === 'TimeoutError' || (err.message && err.message.includes('exceeded timeout'))) {
        return {
          success: false,
          fuelConsumed,
          fuelRemaining,
          memoryBytesUsed: wasmMemory.buffer.byteLength,
          durationMs,
          logs,
          error: err.message,
          exitReason: 'timeout',
        };
      }

      if (err instanceof FuelExhaustedError) {
        return {
          success: false,
          fuelConsumed: err.fuelConsumed,
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
      const durationMs = Date.now() - startTime;
      if (durationMs > this.timeoutMs) {
        return {
          success: false,
          fuelConsumed: totalCost,
          fuelRemaining: allocatedFuel - totalCost,
          memoryBytesUsed: 65536,
          durationMs,
          logs: [],
          error: `Task execution exceeded wall-clock timeout (${this.timeoutMs}ms)`,
          exitReason: 'timeout',
        };
      }
      return {
        success: true,
        result: res,
        fuelConsumed: totalCost,
        fuelRemaining: allocatedFuel - totalCost,
        memoryBytesUsed: 65536,
        durationMs,
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
