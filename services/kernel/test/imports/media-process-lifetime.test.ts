import { expect, test } from 'bun:test';
import { stopBoundaryProcess } from './media-process-lifetime.ts';

test('failed Media bootstrap terminates an unresponsive process and its pipe-owning compiler child', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `process.on('SIGTERM', () => {});
const compiler = Bun.spawn([process.execPath, '-e', "process.on('SIGTERM', () => {}); console.log('compiler ready'); setInterval(() => {}, 1000)"], {
  stdin: 'ignore', stdout: 'inherit', stderr: 'inherit'
});
setInterval(() => {}, 1000);`,
    ],
    { detached: true, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  const reader = child.stdout.getReader();
  try {
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain('compiler ready');
    const started = Date.now();
    await stopBoundaryProcess(child, 50);
    expect(Date.now() - started).toBeLessThan(2_000);
    // EOF requires the descendant that inherited stdout to have exited too.
    expect((await reader.read()).done).toBe(true);
    expect(child.signalCode).toBe('SIGKILL');
    // Cleanup remains safe when the process has already gone away.
    await stopBoundaryProcess(child, 50);
  } finally {
    await stopBoundaryProcess(child, 50);
    reader.releaseLock();
  }
}, 5_000);
