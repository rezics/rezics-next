import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const script = join(root, 'infra/jena/compact-tdb2.sh');
const ownerScript = join(root, 'infra/jena/fuseki-owner.sh');
const directories: string[] = [];
const children: ChildProcess[] = [];

function fixture() {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const base = mkdtempSync(join(root, '.temp/compaction-'));
  directories.push(base);
  const state = join(base, 'databases/rezics');
  const bin = join(base, 'bin');
  mkdirSync(join(state, 'tdb2/Data-0001'), { recursive: true });
  mkdirSync(join(state, 'lucene'));
  mkdirSync(bin);
  writeFileSync(join(state, 'tdb2/Data-0001/quads'), 'exact named-graph fixture\n');
  writeFileSync(join(state, 'lucene/segments_1'), 'retained text cut');
  writeFileSync(join(state, 'clean-stop'), '');
  const executable = (name: string, text: string) =>
    writeFileSync(join(bin, name), `#!/bin/sh\nset -eu\n${text}\n`, { mode: 0o755 });
  executable('sync', ':');
  executable('date', 'if [ "$1" = +%s ]; then echo "$TEST_NOW"; else exec /bin/date "$@"; fi');
  executable(
    'du',
    'case "$*" in *--apparent-size*) echo "150 fixture" ;; *) echo "100 fixture" ;; esac',
  );
  executable(
    'df',
    'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 10000 100 %s 1%% /fixture\\n" "$FREE_KIB"',
  );
  executable(
    'java',
    `printf '%s\\n' "$@" > "$FUSEKI_BASE/java-args"
state="$FUSEKI_BASE/databases/rezics"
case "\${JAVA_MODE:-success}" in
  fail) mkdir "$state/tdb2/Data-0002-tmp"; echo 'injected copy failure' >&2; exit 1 ;;
  publish-fail) cp -R "$state/tdb2/Data-0001" "$state/tdb2/Data-0002"; exit 1 ;;
  no-output) exit 0 ;;
  block) touch "$FUSEKI_BASE/java-started"; sleep 30 ;;
esac
cp -R "$state/tdb2/Data-0001" "$state/tdb2/\${NEXT_GENERATION:-Data-0002}"`,
  );
  const env = {
    ...process.env,
    FUSEKI_BASE: base,
    PATH: `${bin}:${process.env.PATH}`,
    TEST_NOW: '2000000000',
    FREE_KIB: '301',
  };
  const run = (
    args = ['compact', 'maintenance', '2000000100', '1024'],
    extra: Record<string, string> = {},
  ) =>
    spawnSync('sh', [script, ...args], {
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 10_000,
    });
  return {
    base,
    state,
    env,
    run,
    record: join(state, 'compaction/maintenance'),
    fence: join(base, 'databases/purge.incomplete'),
  };
}
async function started(child: ChildProcess, path: string) {
  children.push(child);
  for (let i = 0; i < 200 && !existsSync(path); i++) await Bun.sleep(10);
  expect(existsSync(path)).toBe(true);
}
afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      /* Already exited. */
    }
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test('live owner refuses compaction, recovery and retirement before touching state', async () => {
  const f = fixture();
  const child = spawn(
    'sh',
    [ownerScript, 'sh', '-c', 'touch "$FUSEKI_BASE/owner-started"; exec sleep 30'],
    { env: f.env, detached: true, stdio: 'ignore' },
  );
  await started(child, join(f.base, 'owner-started'));
  writeFileSync(join(f.state, 'clean-stop'), '');
  for (const args of [
    ['compact', 'maintenance', '2000000100', '1024'],
    ['rollback', 'maintenance'],
    ['retire', 'maintenance', '--verified'],
  ]) {
    const result = f.run(args);
    expect(result.status).toBe(75);
    expect(result.stderr).toContain('another process owns');
  }
  expect(existsSync(f.record)).toBe(false);
  expect(existsSync(join(f.base, 'java-args'))).toBe(false);
});

test('unclean stop and insufficient disk headroom refuse without launching Java', () => {
  const f = fixture();
  rmSync(join(f.state, 'clean-stop'));
  expect(f.run().stderr).toContain('cleanly stopped');
  writeFileSync(join(f.state, 'clean-stop'), '');
  const result = f.run(undefined, { FREE_KIB: '300' });
  expect(result.status).toBe(75);
  expect(result.stdout).toContain('required-free-kib=301');
  expect(result.stderr).toContain('inadequate disk');
  expect(existsSync(f.record)).toBe(false);
  expect(existsSync(join(f.base, 'java-args'))).toBe(false);
  expect(existsSync(join(f.state, 'clean-stop'))).toBe(true);
});

test('successful boundary preflight retains exact old and text cuts with named evidence', () => {
  const f = fixture();
  const result = f.run();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('no concurrent disk consumers assumed');
  expect(readFileSync(join(f.record, 'evidence'), 'utf8')).toContain('replacement-budget-kib=300');
  expect(readFileSync(join(f.record, 'retain-until'), 'utf8')).toBe('2000000100\n');
  expect(readFileSync(join(f.record, 'phase'), 'utf8')).toBe('retained\n');
  expect(readFileSync(join(f.state, 'tdb2/Data-0001/quads'), 'utf8')).toBe(
    'exact named-graph fixture\n',
  );
  expect(readFileSync(join(f.state, 'lucene/segments_1'), 'utf8')).toBe('retained text cut');
  expect(readFileSync(join(f.base, 'java-args'), 'utf8')).not.toContain('--deleteOld');
  expect(existsSync(f.fence)).toBe(false);
  expect(existsSync(join(f.state, 'clean-stop'))).toBe(true);
  expect(f.run(['status', 'maintenance']).stdout).toContain('retained');
  expect(f.run(['compact', 'second', '2000000200', '0']).status).toBe(75);
});

for (const javaMode of ['fail', 'publish-fail', 'no-output']) {
  test(`compaction ${javaMode} keeps the startup fence and supports explicit offline recovery`, () => {
    const f = fixture();
    const result = f.run(undefined, { JAVA_MODE: javaMode });
    expect(result.status).toBe(75);
    expect(existsSync(f.fence)).toBe(true);
    expect(existsSync(join(f.state, 'clean-stop'))).toBe(false);
    expect(existsSync(join(f.state, 'tdb2/Data-0001/quads'))).toBe(true);
    const blockedOwner = spawnSync('sh', [ownerScript, 'true'], { env: f.env, encoding: 'utf8' });
    expect(blockedOwner.status).toBe(75);
    expect(f.run().status).toBe(75);
    expect(f.run(['rollback', 'maintenance']).status).toBe(0);
    expect(readFileSync(join(f.record, 'phase'), 'utf8')).toBe('rolled-back\n');
    expect(existsSync(f.fence)).toBe(false);
    expect(existsSync(join(f.state, 'clean-stop'))).toBe(true);
    if (javaMode !== 'no-output')
      expect(
        existsSync(
          join(f.record, 'quarantine', javaMode === 'fail' ? 'Data-0002-tmp' : 'Data-0002'),
        ),
      ).toBe(true);
    expect(existsSync(join(f.state, 'tdb2/Data-0002'))).toBe(false);
  });
}

test('compactor and inherited JVM retain the owner lock throughout work and interruption', async () => {
  const f = fixture();
  const child = spawn('sh', [script, 'compact', 'maintenance', '2000000100', '1024'], {
    env: { ...f.env, JAVA_MODE: 'block' },
    detached: true,
    stdio: 'ignore',
  });
  await started(child, join(f.base, 'java-started'));
  expect(f.run(['rollback', 'maintenance']).stderr).toContain('another process owns');
  // Kill only the supervisor: the JVM still holds its inherited lock.
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  process.kill(child.pid!, 'SIGKILL');
  await exited;
  expect(f.run(['rollback', 'maintenance']).stderr).toContain('another process owns');
  process.kill(-child.pid!, 'SIGKILL');
  let recovered = f.run(['rollback', 'maintenance']);
  for (let i = 0; i < 100 && recovered.status !== 0; i++) {
    await Bun.sleep(10);
    recovered = f.run(['rollback', 'maintenance']);
  }
  expect(recovered.status).toBe(0);
});

test('successful rollback is permitted before resume, and refused after the stop marker changes', () => {
  let f = fixture();
  expect(f.run().status).toBe(0);
  expect(f.run(['rollback', 'maintenance']).status).toBe(0);
  expect(existsSync(join(f.record, 'quarantine/Data-0002'))).toBe(true);
  expect(existsSync(join(f.state, 'tdb2/Data-0001'))).toBe(true);
  f = fixture();
  expect(f.run().status).toBe(0);
  writeFileSync(join(f.state, 'clean-stop'), 'later stop');
  expect(f.run(['rollback', 'maintenance']).stderr).toContain('owner has resumed');
  expect(existsSync(join(f.state, 'tdb2/Data-0002'))).toBe(true);
});

test('retirement needs explicit verification, expiry and the recorded replacement', () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  expect(f.run(['retire', 'maintenance']).status).toBe(64);
  expect(f.run(['retire', 'maintenance', '--verified']).stderr).toContain('has not expired');
  mkdirSync(join(f.state, 'tdb2/Data-0003'));
  expect(
    f.run(['retire', 'maintenance', '--verified'], { TEST_NOW: '2000000100' }).stderr,
  ).toContain('unexpected generation');
  rmSync(join(f.state, 'tdb2/Data-0003'), { recursive: true });
  const result = f.run(['retire', 'maintenance', '--verified'], { TEST_NOW: '2000000100' });
  expect(result.status).toBe(0);
  expect(existsSync(join(f.state, 'tdb2/Data-0001'))).toBe(false);
  expect(existsSync(join(f.state, 'tdb2/Data-0002'))).toBe(true);
  expect(readFileSync(join(f.record, 'retirement'), 'utf8')).toContain('operator-verified=true');
  expect(f.run(['rollback', 'maintenance']).status).toBe(75);
});

test('interrupted retirement resumes after source deletion without deleting the replacement', () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  writeFileSync(join(f.record, 'phase'), 'retiring\n');
  rmSync(join(f.state, 'tdb2/Data-0001'), { recursive: true });
  expect(f.run(['retire', 'maintenance', '--verified'], { TEST_NOW: '2000000100' }).status).toBe(0);
  expect(existsSync(join(f.state, 'tdb2/Data-0002/quads'))).toBe(true);
});

test('invalid, empty, temporary and linked generations and foreign fences refuse', () => {
  for (const kind of ['empty', 'temporary', 'linked', 'foreign-fence']) {
    const f = fixture();
    if (kind === 'empty') rmSync(join(f.state, 'tdb2/Data-0001'), { recursive: true });
    if (kind === 'temporary') mkdirSync(join(f.state, 'tdb2/Data-0002-tmp'));
    if (kind === 'linked')
      symlinkSync(join(f.state, 'tdb2/Data-0001'), join(f.state, 'tdb2/Data-0002'));
    if (kind === 'foreign-fence') writeFileSync(f.fence, 'erasure');
    expect(f.run().status).toBe(75);
    expect(existsSync(join(f.base, 'java-args'))).toBe(false);
  }
});

test('generation numbering grows beyond four digits and zero-argument candidate caller retains its window', () => {
  const f = fixture();
  rmSync(join(f.state, 'tdb2/Data-0001'), { recursive: true });
  mkdirSync(join(f.state, 'tdb2/Data-9999'));
  // This fixture branch only needs to publish the expected path.
  writeFileSync(
    join(f.base, 'bin/java'),
    '#!/bin/sh\nmkdir "$FUSEKI_BASE/databases/rezics/tdb2/Data-10000"\n',
    { mode: 0o755 },
  );
  expect(f.run(undefined, { NEXT_GENERATION: 'Data-10000' }).status).toBe(0);
  expect(readFileSync(join(f.record, 'target'), 'utf8')).toBe('Data-10000\n');
  const candidate = fixture();
  const result = candidate.run([], { FREE_KIB: '2000000' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('retained recovery window compact-');
});

test('rollback never hides an unexpected newer generation or releases a foreign fence', () => {
  const f = fixture();
  expect(f.run(undefined, { JAVA_MODE: 'publish-fail' }).status).toBe(75);
  mkdirSync(join(f.state, 'tdb2/Data-0003'));
  expect(f.run(['rollback', 'maintenance']).stderr).toContain('unexpected generation');
  rmSync(join(f.state, 'tdb2/Data-0003'), { recursive: true });
  writeFileSync(f.fence, 'other-maintenance');
  expect(f.run(['rollback', 'maintenance']).stderr).toContain('another maintenance operation');
  expect(readFileSync(f.fence, 'utf8')).toBe('other-maintenance');
  expect(existsSync(join(f.state, 'tdb2/Data-0002'))).toBe(true);
});

test('rollback resumes a quarantined replacement and finalizes an interrupted fence release', () => {
  const f = fixture();
  expect(f.run(undefined, { JAVA_MODE: 'publish-fail' }).status).toBe(75);
  expect(f.run(['rollback', 'maintenance']).status).toBe(0);
  writeFileSync(f.fence, 'tdb2-compaction:maintenance\n');
  expect(f.run(['rollback', 'maintenance']).status).toBe(0);
  expect(existsSync(f.fence)).toBe(false);
  expect(f.run(['rollback', 'maintenance']).status).toBe(0);
  expect(existsSync(join(f.record, 'quarantine/Data-0002'))).toBe(true);
});

test('retirement cannot delete the current generation through a mismatched recovery record', () => {
  const f = fixture();
  expect(f.run().status).toBe(0);
  writeFileSync(join(f.record, 'source'), 'Data-0002\n');
  expect(
    f.run(['retire', 'maintenance', '--verified'], { TEST_NOW: '2000000100' }).stderr,
  ).toContain('not the next generation');
  expect(existsSync(join(f.state, 'tdb2/Data-0002/quads'))).toBe(true);
});

test('failed fence publication preserves the original stop and can recover from its prepared record', () => {
  const f = fixture();
  writeFileSync(
    join(f.base, 'bin/mv'),
    `#!/bin/sh
if [ "$2" = "$FUSEKI_BASE/databases/purge.incomplete" ]; then exit 1; fi
exec /bin/mv "$@"
`,
    { mode: 0o755 },
  );
  expect(f.run().status).toBe(1);
  expect(existsSync(f.fence)).toBe(false);
  expect(existsSync(join(f.state, 'clean-stop'))).toBe(true);
  expect(readFileSync(join(f.record, 'startup-fence.next'), 'utf8')).toBe(
    'tdb2-compaction:maintenance\n',
  );
  expect(readFileSync(join(f.record, 'phase'), 'utf8')).toBe('prepared\n');
  expect(existsSync(join(f.base, 'java-args'))).toBe(false);
  rmSync(join(f.base, 'bin/mv'));
  expect(f.run(['rollback', 'maintenance']).status).toBe(0);
});

test('an owner delayed before locking rechecks the failed-compaction fence before starting Java', async () => {
  const f = fixture();
  writeFileSync(
    join(f.base, 'bin/flock'),
    `#!/bin/sh
if [ "$GATE_OWNER" = 1 ]; then
  touch "$FUSEKI_BASE/owner-at-lock"
  while [ ! -e "$FUSEKI_BASE/release-owner" ]; do sleep 0.01; done
fi
exec /usr/bin/flock "$@"
`,
    { mode: 0o755 },
  );
  const owner = spawn('sh', [ownerScript, 'sh', '-c', 'touch "$FUSEKI_BASE/owner-child-started"'], {
    env: { ...f.env, GATE_OWNER: '1' },
    detached: true,
    stdio: 'ignore',
  });
  await started(owner, join(f.base, 'owner-at-lock'));
  expect(f.run(undefined, { JAVA_MODE: 'publish-fail', GATE_OWNER: '0' }).status).toBe(75);
  const exited = new Promise((resolveExit) => owner.once('exit', resolveExit));
  writeFileSync(join(f.base, 'release-owner'), '');
  await exited;
  expect(owner.exitCode).toBe(75);
  expect(existsSync(join(f.base, 'owner-child-started'))).toBe(false);
  expect(existsSync(f.fence)).toBe(true);
  expect(f.run(['rollback', 'maintenance'], { GATE_OWNER: '0' }).status).toBe(0);
});
