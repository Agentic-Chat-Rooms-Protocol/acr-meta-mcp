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
});
