import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { ExecutionResult, ProcessSpawnSpec } from './types.js';
import { getSanitizedEnvironment } from './profiles.js';

export class SandboxedProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private isKilled = false;

  constructor(private readonly spec: ProcessSpawnSpec) {}

  public spawn(): ChildProcessWithoutNullStreams {
    const env = getSanitizedEnvironment(this.spec.env, this.spec.policy);

    this.child = spawn(this.spec.command, this.spec.args, {
      env,
      cwd: this.spec.cwd || process.cwd(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return this.child;
  }

  public async executeOnce(inputPayload?: string): Promise<ExecutionResult> {
    const startTime = Date.now();
    const child = this.spawn();

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeoutMs = this.spec.policy.timeoutMs || 30000;
      const timer = setTimeout(() => {
        timedOut = true;
        this.kill();
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        // Memory safety guard: cap stdout at 10MB
        if (stdout.length > 10 * 1024 * 1024) {
          this.kill();
        }
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          exitCode: code,
          durationMs: Date.now() - startTime,
          timedOut,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        stderr += `\nSpawn error: ${err.message}`;
        resolve({
          stdout,
          stderr,
          exitCode: -1,
          durationMs: Date.now() - startTime,
          timedOut,
        });
      });

      if (inputPayload) {
        child.stdin.write(inputPayload);
        child.stdin.end();
      }
    });
  }

  public kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.child && !this.isKilled) {
      this.isKilled = true;
      try {
        this.child.kill(signal);
      } catch {
        // Ignore kill errors if already terminated
      }
    }
  }

  public get process(): ChildProcessWithoutNullStreams | null {
    return this.child;
  }
}
