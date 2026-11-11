import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WasmExecutor, FuelExhaustedError } from '../src/wasm_executor.js';

describe('WasmExecutor: Fuel-Metered WebAssembly Sandbox Runtime', () => {
  // Valid minimal WASM module returning i32 constant 42 from export "run"
  const minimalWasmBytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    // Type section (1)
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
    // Function section (3)
    0x03, 0x02, 0x01, 0x00,
    // Export section (7): export "run" -> func 0
    0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x00,
    // Code section (10): body returns 42 (i32.const 42, end)
    0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x2a, 0x0b,
  ]);

  it('compiles and executes valid sandboxed WebAssembly module', async () => {
    const executor = new WasmExecutor({ maxFuel: 500_000 });
    const res = await executor.execute(minimalWasmBytes, 'run');

    assert.equal(res.success, true);
    assert.equal(res.result, 42);
    assert.equal(res.exitReason, 'ok');
    assert.ok(res.memoryBytesUsed >= 65536);
    assert.ok(res.durationMs >= 0);
  });

  it('reports error when requested entrypoint is missing in exports', async () => {
    const executor = new WasmExecutor();
    const res = await executor.execute(minimalWasmBytes, 'nonexistent_fn');

    assert.equal(res.success, false);
    assert.equal(res.exitReason, 'trap');
    assert.match(res.error!, /not found in WASM exports/);
  });

  it('executes fuel-metered task and deducts consumed units', () => {
    const executor = new WasmExecutor({ maxFuel: 100_000 });
    const res = executor.executeTask(
      10, // 10 units per step
      50, // 50 steps -> 500 units total
      () => 123 * 456
    );

    assert.equal(res.success, true);
    assert.equal(res.result, 56088);
    assert.equal(res.fuelConsumed, 500);
    assert.equal(res.fuelRemaining, 99500);
    assert.equal(res.exitReason, 'ok');
  });

  it('aborts with out_of_fuel when task exceeds fuel budget', () => {
    const executor = new WasmExecutor({ maxFuel: 1_000 });
    const res = executor.executeTask(
      100, // 100 units per step
      20,  // 20 steps -> 2,000 units (> 1,000 max)
      () => 'should not complete'
    );

    assert.equal(res.success, false);
    assert.equal(res.exitReason, 'out_of_fuel');
    assert.equal(res.fuelConsumed, 1000);
    assert.equal(res.fuelRemaining, 0);
    assert.match(res.error!, /exceeded fuel budget/);
  });

  it('aborts with timeout when task execution exceeds timeoutMs', () => {
    const executor = new WasmExecutor({ timeoutMs: 20 });
    const res = executor.executeTask(
      1,
      1,
      () => {
        // Busy wait for > 30ms to exceed 20ms timeout
        const start = Date.now();
        while (Date.now() - start < 35) {}
        return 'delayed';
      }
    );

    assert.equal(res.success, false);
    assert.equal(res.exitReason, 'timeout');
    assert.match(res.error!, /exceeded wall-clock timeout/);
  });

  it('Experiment 10 (WASM Experiment): denies prohibited host imports before instantiation and bounds excessive computation & memory', async () => {
    const executor = new WasmExecutor({
      maxFuel: 100,
      maxMemoryBytes: 64 * 1024, // 1 WASM page (64 KB) ceiling
    });

    // 1. WASM module importing prohibited capability "env.host_network_connect" -> DENIED BEFORE INSTANTIATION
    // (module (type (func)) (import "env" "host_network_connect" (func (type 0))))
    const prohibitedImportWasm = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      // Type section: 1 func () -> ()
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
      // Import section (28 bytes = 0x1c): import "env" "host_network_connect" func 0
      0x02, 0x1c, 0x01,
      0x03, 0x65, 0x6e, 0x76, // "env"
      0x14, 0x68, 0x6f, 0x73, 0x74, 0x5f, 0x6e, 0x65, 0x74, 0x77, 0x6f, 0x72, 0x6b, 0x5f, 0x63, 0x6f, 0x6e, 0x6e, 0x65, 0x63, 0x74, // "host_network_connect"
      0x00, 0x00,
    ]);

    const importDeniedRes = await executor.execute(prohibitedImportWasm, 'run');
    assert.equal(importDeniedRes.success, false);
    assert.equal(importDeniedRes.exitReason, 'host_import_denied');
    assert.match(importDeniedRes.error!, /env\.host_network_connect/);

    // 2. WASM module importing allowed "env.burn_fuel" and attempting excessive computation (burning 500 fuel > 100 quota)
    // (module
    //   (type (func (param i32)))
    //   (type (func (result i32)))
    //   (import "env" "burn_fuel" (func (type 0)))
    //   (func (export "run") (type 1) i32.const 500 call 0 i32.const 1)
    // )
    const excessiveFuelWasm = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      // Type section: type 0 = (i32)->(), type 1 = ()->(i32)
      0x01, 0x09, 0x02, 0x60, 0x01, 0x7f, 0x00, 0x60, 0x00, 0x01, 0x7f,
      // Import section: "env"."burn_fuel" (func type 0)
      0x02, 0x11, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x09, 0x62, 0x75, 0x72, 0x6e, 0x5f, 0x66, 0x75, 0x65, 0x6c, 0x00, 0x00,
      // Function section: 1 func of type 1
      0x03, 0x02, 0x01, 0x01,
      // Export section: "run" -> func index 1
      0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x01,
      // Code section: i32.const 500 (0x41 0xf4 0x03), call 0 (0x10 0x00), i32.const 1 (0x41 0x01), end (0x0b)
      0x0a, 0x0b, 0x01, 0x09, 0x00, 0x41, 0xf4, 0x03, 0x10, 0x00, 0x41, 0x01, 0x0b,
    ]);

    const fuelRes = await executor.execute(excessiveFuelWasm, 'run');
    assert.equal(fuelRes.success, false);
    assert.equal(fuelRes.exitReason, 'out_of_fuel');
    assert.equal(fuelRes.fuelRemaining, 0);

    // 3. WASM module declaring 4 pages (256 KB) of exported linear memory exceeding the 1-page (64 KB) ceiling
    const excessiveMemoryWasm = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      // Type section: () -> i32
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
      // Function section
      0x03, 0x02, 0x01, 0x00,
      // Memory section (5): 1 memory with min=4 pages (256 KB > 64 KB ceiling)
      0x05, 0x03, 0x01, 0x00, 0x04,
      // Export section (7): 16 bytes (0x10) -> export "memory" (mem 0) and "run" (func 0)
      0x07, 0x10, 0x02,
      0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00,
      0x03, 0x72, 0x75, 0x6e, 0x00, 0x00,
      // Code section
      0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x2a, 0x0b,
    ]);

    const memRes = await executor.execute(excessiveMemoryWasm, 'run');
    assert.equal(memRes.success, false);
    assert.equal(memRes.exitReason, 'memory_limit');
    assert.match(memRes.error!, /InitialMemoryExceededError/);

    // 4. Verify static binary header inspection for Section 5 (Memory) and Section 2 (Imported Memory)
    assert.equal(WasmExecutor.inspectDeclaredMemoryPages(excessiveMemoryWasm), 4);
    const importedMem300Pages = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      // Import section (2): 1 import "env"."memory" kind=0x02 (memory), flags=0x00, initial=300 (0xac 0x02)
      0x02, 0x0f, 0x01,
      0x03, 0x65, 0x6e, 0x76,
      0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79,
      0x02, 0x00, 0xac, 0x02,
    ]);
    assert.equal(WasmExecutor.inspectDeclaredMemoryPages(importedMem300Pages), 300);
  });
});

