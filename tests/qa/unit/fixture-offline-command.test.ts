import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createCommandOutputRedactor } from '../../../scripts/fixture/command-output.ts';
import { run, stream } from '../../../scripts/fixture/stack.ts';
import { command, commandAsync } from '../../../scripts/qa/core.ts';
import { boundedComposeFailure } from '../fault-recovery/search-ops-support.ts';

const root = resolve(import.meta.dir, '../../..');
const secret = 'supersecretvalue';

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
  const result = spawnSync(
    process.execPath,
    ['-e', 'const data=await Bun.stdin.bytes(); process.stdout.write(Buffer.from(data));'],
    {
      encoding: 'utf8',
      input: payload,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(payload);
  expect(result.stderr).toBe('');
});

test('a token directly after an ANSI sequence is redacted', () => {
  const text = boundedComposeFailure('run', {
    status: 2,
    output: `\x1b[31mxFUSEKI_COMMAND_TOKEN=${secret}`,
  });
  expect(text).toContain('status=2 signal=null error=null');
  expect(text).toContain('\x1b[31mxFUSEKI_COMMAND_TOKEN=[redacted]');
  expect(text).not.toContain(secret);
});

test('a token inside an ANSI color span is redacted', () => {
  const text = boundedComposeFailure('run', {
    status: 2,
    output: `\x1b[31mFUSEKI_COMMAND_TOKEN=${secret}\x1b[0m`,
  });
  expect(text).toContain('\x1b[31mFUSEKI_COMMAND_TOKEN=[redacted]\x1b[0m');
  expect(text).not.toContain(secret);
});

test('a token immediately before an ANSI sequence keeps the sequence and the following text', () => {
  const text = boundedComposeFailure('run', {
    status: 2,
    error: { message: `FUSEKI_COMMAND_TOKEN=${secret}\x1b[0mtrailing` } as NodeJS.ErrnoException,
    output: '',
  });
  expect(text).toContain(`FUSEKI_COMMAND_TOKEN=[redacted]\x1b[0mtrailing`);
  expect(text).not.toContain(secret);
});

test('a token split across two stream chunks is redacted', () => {
  const redactor = createCommandOutputRedactor();
  const head = redactor.push('\x1b[31mFUSEKI_COMMAND_TO');
  const tail = redactor.push(`KEN=${secret}`);
  const rest = redactor.finish();
  expect(head).not.toContain(secret);
  expect(tail).not.toContain(secret);
  expect(rest).not.toContain(secret);
  expect(head + tail + rest).toBe('\x1b[31mFUSEKI_COMMAND_TOKEN=[redacted]');
});

test('a near-miss value beside a colored token is left intact', () => {
  const text = boundedComposeFailure('run', {
    status: 2,
    output: `FUSEKI_COMMAND_TOKEN=${secret}\x1b[0mnear-miss-value FUSEKI_COMMAND_TOKENS=plural-stays MODE=${secret}-extended`,
  });
  expect(text).toContain('FUSEKI_COMMAND_TOKEN=[redacted]\x1b[0mnear-miss-value');
  expect(text).toContain('FUSEKI_COMMAND_TOKENS=plural-stays');
  expect(text).toContain(`MODE=${secret}-extended`);
  expect(text).not.toContain(`FUSEKI_COMMAND_TOKEN=${secret}`);
});

test('stdout, stderr and a fixture failure redact a colored token', () => {
  const printed = command(
    root,
    process.execPath,
    [
      '-e',
      `process.stdout.write("\\x1b[31mFUSEKI_COMMAND_TOKEN=${secret}\\n"); process.stderr.write("FUSEKI_COMMAND_TOKEN=${secret}\\x1b[0mnext");`,
    ],
    10_000,
  );
  expect(printed.output).toContain('FUSEKI_COMMAND_TOKEN=[redacted]');
  expect(printed.output).toContain('\x1b[0mnext');
  expect(printed.output).not.toContain(secret);

  let message = '';
  try {
    run(
      process.execPath,
      ['-e', `console.error("\\x1b[31mFUSEKI_COMMAND_TOKEN=${secret}"); process.exit(3)`],
      process.env,
      10_000,
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('FUSEKI_COMMAND_TOKEN=[redacted]');
  expect(message).not.toContain(secret);
});

test('streamed command lines kept for logs redact a colored token', async () => {
  const lines: string[] = [];
  const logged = await commandAsync(
    root,
    process.execPath,
    ['-e', `console.error("\\x1b[31mFUSEKI_COMMAND_TOKEN=${secret}")`],
    10_000,
    process.env,
    (line) => lines.push(line),
  );
  expect(logged.output).toContain('FUSEKI_COMMAND_TOKEN=[redacted]');
  expect(logged.output).not.toContain(secret);
  expect(lines.join('\n')).toContain('FUSEKI_COMMAND_TOKEN=[redacted]');
  expect(lines.join('\n')).not.toContain(secret);

  const output = await stream(
    process.execPath,
    [
      '-e',
      `process.stdout.write("\\x1b[31mFUSEKI_COMMAND_TO"); await new Promise(resolve => setTimeout(resolve, 30)); process.stdout.write("KEN=${secret}");`,
    ],
    process.env,
    undefined,
    10_000,
  );
  expect(output).toContain('FUSEKI_COMMAND_TOKEN=[redacted]');
  expect(output).not.toContain(secret);
});
