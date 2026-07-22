import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { ProcessShutdownController } from './process-shutdown.js';

describe('ProcessShutdownController', () => {
  it('deduplicates shutdown and upgrades an in-flight signal exit to fatal', async () => {
    let finishClose!: () => void;
    const close = vi.fn(() => new Promise<void>((resolveClose) => (finishClose = resolveClose)));
    const exit = vi.fn();
    const controller = new ProcessShutdownController({ close, fatal: vi.fn(), exit });

    const signal = controller.shutdown(0, 'SIGTERM');
    const rejection = controller.shutdown(1, 'unhandled promise rejection', new Error('boom'));
    expect(signal).toBe(rejection);
    await Promise.resolve();
    finishClose();
    await signal;

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it.each([
    ['healthy', 0, 3000],
    ['stuck', 1, 7000],
  ] as const)(
    'child process %s shutdown exits with %i',
    async (mode, expectedCode, timeoutMs) => {
      const fixtureDirectory = mkdtempSync(join(tmpdir(), 'flash-api-shutdown-'));
      for (const sourceName of ['process-shutdown.ts', 'process-shutdown.child.ts']) {
        const sourcePath = resolve(__dirname, sourceName);
        const output = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
          fileName: sourcePath,
        });
        writeFileSync(
          join(fixtureDirectory, sourceName.replace(/\.ts$/, '.js')),
          output.outputText,
        );
      }
      const childPath = join(fixtureDirectory, 'process-shutdown.child.js');
      const result = await new Promise<{ code: number | null; stderr: string }>(
        (resolveResult, reject) => {
          const child = spawn(process.execPath, [childPath, mode], {
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          let stderr = '';
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (chunk: string) => (stderr += chunk));
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`child did not exit within ${timeoutMs}ms`));
          }, timeoutMs);
          child.once('exit', (code) => {
            clearTimeout(timer);
            resolveResult({ code, stderr });
          });
          child.once('error', reject);
        },
      );
      rmSync(fixtureDirectory, { recursive: true, force: true });

      expect(result.code).toBe(expectedCode);
      if (mode === 'stuck') expect(result.stderr).toContain('forcing exit');
    },
    8000,
  );
});
