import { expect, test } from 'bun:test';
import { runIdentityBootstrap } from './identity-fixture.ts';

type Spawn = NonNullable<Parameters<typeof runIdentityBootstrap>[3]>;
type Diagnostic = {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};
const url = 'postgres://diagnostic_user:diagnostic_password@localhost/diagnostic_database';
const accountId = '00000000-0000-8000-8000-123400000001';
const cap = 16_384;

async function requiredFailure(spawn: Spawn) {
  let caught: unknown;
  try {
    await runIdentityBootstrap(url, accountId, true, spawn);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  return caught as Error & { cause: Diagnostic };
}

function pipe(chunks: Uint8Array[], closed: () => void) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else {
        closed();
        controller.close();
      }
    },
  });
}

test('required CLI exit 1 retains child diagnostic sentinels with the unchanged operator invocation', async () => {
  let calls = 0;
  const failure = await requiredFailure((command, options) => {
    calls++;
    expect(command).toEqual([
      process.execPath,
      'services/kernel/scripts/bootstrap-governance.ts',
      '--account',
      accountId,
    ]);
    expect(options.cwd).toBe(new URL('../../../../', import.meta.url).pathname);
    expect(options.stdout).toBe('pipe');
    expect(options.stderr).toBe('pipe');
    expect(options.env.DATABASE_URL === url).toBe(true);
    // A real synthetic subprocess supplies the failure, without invoking a DB or
    // replacing any native bootstrap authority in the production fixture.
    return Bun.spawn(
      [
        process.execPath,
        '--eval',
        "console.log('stdout-sentinel'); console.error('native-diagnostic-sentinel'); process.exit(1)",
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
  });
  expect(calls).toBe(1);
  expect(failure.message).toBe('Deployment governance bootstrap exited 1');
  expect(failure.cause).toEqual({
    exitCode: 1,
    stdout: 'stdout-sentinel\n',
    stderr: 'native-diagnostic-sentinel\n',
    stdoutTruncated: false,
    stderrTruncated: false,
  });
});

for (const [required, exitCode] of [
  [true, 0],
  [false, 0],
  [false, 1],
  [false, 73],
] as const) {
  test(`required=${required}, exit=${exitCode} returns only the exit code after draining both pipes`, async () => {
    let drained = 0;
    const spawn: Spawn = () => ({
      exited: Promise.resolve(exitCode),
      stdout: pipe([new Uint8Array(cap * 2)], () => drained++),
      stderr: pipe([new Uint8Array(cap * 2)], () => drained++),
    });
    expect(await runIdentityBootstrap(url, accountId, required, spawn)).toEqual({ exitCode });
    expect(drained).toBe(2);
  });
}

for (const size of [cap, cap + 1, cap * 32]) {
  for (const chunkSize of [137, cap * 32]) {
    test(`required failure bounds ${size} output bytes in ${chunkSize}-byte chunks and drains the remainder`, async () => {
      let drained = 0;
      const output = Buffer.from(`diagnostic-sentinel\n${'π'.repeat(size)}`).subarray(0, size);
      const chunks = Array.from({ length: Math.ceil(size / chunkSize) }, (_, index) =>
        output.subarray(index * chunkSize, (index + 1) * chunkSize),
      );
      const failure = await requiredFailure(() => ({
        exited: Promise.resolve(1),
        stdout: pipe(chunks, () => drained++),
        stderr: pipe(chunks, () => drained++),
      }));
      expect(drained).toBe(2);
      expect(failure.cause.exitCode).toBe(1);
      for (const stream of ['stdout', 'stderr'] as const) {
        expect(failure.cause[stream]).toStartWith('diagnostic-sentinel\n');
        expect(Buffer.byteLength(failure.cause[stream])).toBeLessThanOrEqual(cap);
        expect(failure.cause[`${stream}Truncated`]).toBe(size > cap);
      }
    });
  }
}

test('retained child evidence excludes the database locator and credentials, including a cut locator', async () => {
  const output = Buffer.from(`native-sentinel ${url} diagnostic_user diagnostic_password\n`);
  const cut = Buffer.from(`${'x'.repeat(cap - 20)}${url}`);
  const failure = await requiredFailure(() => ({
    exited: Promise.resolve(1),
    stdout: pipe([output.subarray(0, 27), output.subarray(27)], () => {}),
    stderr: pipe([cut], () => {}),
  }));
  expect(failure.cause.stdout).toContain('native-sentinel');
  const evidence = JSON.stringify(failure.cause);
  for (const secret of [url, 'diagnostic_user', 'diagnostic_password', 'postgres://'])
    expect(evidence.includes(secret)).toBe(false);
  expect(failure.cause.stderrTruncated).toBe(true);
});
