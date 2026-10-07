import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { boundedComposeFailure } from '../fault-recovery/search-ops-support.ts';

function captured(result: ReturnType<typeof spawnSync>) {
  return {
    status: result.status,
    signal: result.signal,
    error: result.error as NodeJS.ErrnoException | undefined,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

test('an unstarted compose command keeps the real status, error and signal', () => {
  const payload = 'p'.repeat(131_073);
  const result = captured(spawnSync('docker', ['compose', 'run', payload], { encoding: 'utf8' }));
  expect(result.status ?? null).toBeNull();
  expect(result.signal).toBeNull();
  expect(result.error?.code).toBe('E2BIG');
  expect(result.output).toBe('');
  const text = boundedComposeFailure('run', result, Buffer.byteLength(payload));
  expect(text).toContain('docker compose run failed: status=null signal=null error=E2BIG');
  expect(text).toContain('privateBytes=131073');
  expect(text).not.toContain(payload);
});

test('a signaled command and a printed token stay bounded', () => {
  const killed = captured(
    spawnSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], {
      encoding: 'utf8',
    }),
  );
  expect(killed.signal).toBe('SIGTERM');
  expect(killed.status ?? null).toBeNull();
  expect(boundedComposeFailure('run', killed)).toContain('status=null signal=SIGTERM error=null');

  const leaked = captured(
    spawnSync(
      process.execPath,
      ['-e', 'console.error("FUSEKI_COMMAND_TOKEN=supersecretvalue"); process.exit(2)'],
      { encoding: 'utf8' },
    ),
  );
  expect(leaked.status).toBe(2);
  const text = boundedComposeFailure('run', leaked);
  expect(text).toContain('status=2 signal=null error=null');
  expect(text).toContain('FUSEKI_COMMAND_TOKEN=[redacted]');
  expect(text).not.toContain('supersecretvalue');
});

test('a medium-sized private seed reaches stdin intact without entering argv', () => {
  const payload = '<urn:seed> <urn:body> "private-seed" <urn:graph> .\n'.repeat(4096);
  expect(Buffer.byteLength(payload)).toBeGreaterThan(131_072);
  const result = spawnSync(process.execPath, ['-e',
    'const data=await Bun.stdin.bytes(); process.stdout.write(Buffer.from(data));'], {
    encoding: 'utf8', input: payload,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(payload);
  expect(result.stderr).toBe('');
});
