import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { currentCheckSourceManifest, CheckRunUnavailable } from './check-source.ts';
import {
  currentCheckSourceManifest as publicSourceManifest,
  CheckRunUnavailable as PublicUnavailable,
} from './check-run.ts';
import { processIdentity, terminateDetachedGroup } from './check-custody.ts';

const repository = resolve(import.meta.dir, '..');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
    timeout: 5_000,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function fixture(): string {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const root = mkdtempSync(join(repository, '.temp', 'source-tla-'));
  roots.push(root);
  git(root, ['init', '--quiet']);
  writeFileSync(join(root, '.gitignore'), '.temp/\n');
  writeFileSync(join(root, 'input.ts'), 'export const input = true;\n');
  git(root, ['add', '.gitignore', 'input.ts']);
  git(root, ['commit', '--quiet', '-m', 'Fixture']);
  writeFileSync(join(root, 'untracked.ts'), 'export const untracked = true;\n');
  mkdirSync(join(root, '.temp'));
  return root;
}

async function within<T>(promise: Promise<T>, ms: number): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true as const, value })),
      new Promise<{ settled: false }>((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Test-owned descendants are stopped before their waiting Bun parent, so the parent can reap them. */
async function cleanup(
  child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
  identity: NonNullable<ReturnType<typeof processIdentity>>,
) {
  try {
    const children = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const pid of children) {
      const owned = processIdentity(Number(pid));
      if (owned && owned.group === identity.group) process.kill(owned.pid, 'SIGTERM');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await Bun.sleep(50);
  const result = await terminateDetachedGroup(identity, 100);
  expect(result.terminal, result.reason).toBe(true);
  expect((await within(child.exited, 1_000)).settled).toBe(true);
}

test('source-reader public exports keep the same error and function identities', () => {
  expect(publicSourceManifest).toBe(currentCheckSourceManifest);
  expect(PublicUnavailable).toBe(CheckRunUnavailable);
});

test('the real default source reader finishes under an entry top-level await with an owned flock; importing the active entry reproduces the old wait', async () => {
  const root = fixture();
  const directory = join(root, '.temp');
  const entry = join(directory, 'entry.ts');
  const worker = join(directory, 'worker.ts');
  writeFileSync(
    entry,
    `import { work } from './worker.ts';
export { currentCheckSourceManifest } from ${JSON.stringify(join(repository, 'scripts/check-source.ts'))};
await work(import.meta.url, process.argv[2], process.argv[3], process.argv[4]);
`,
  );
  writeFileSync(
    worker,
    `import { withOutputTreeSource } from ${JSON.stringify(join(repository, 'scripts/remote-check.ts'))};
export async function work(entry: string, mode: string, root: string, file: string) {
  const child = Bun.spawn(['flock','-s','--no-fork','-E','75',file,'sh','-c','printf LOCKED\\\\n; exec cat >/dev/null'], {stdin:'pipe',stdout:'pipe',stderr:'ignore'});
  const reader = child.stdout.getReader(); await reader.read(); reader.releaseLock();
  try {
    console.log('source-read-start');
    await Bun.write(file + '.ready', 'ready');
    if (mode === 'old-cycle') {
      const imported = await import(entry);
      await imported.currentCheckSourceManifest(root);
    } else {
      // No transport or command runs: the production default reads the real local Git source catalogue.
      const pinned = await withOutputTreeSource({hosts:[],workspace:root,command:['bun','services/kernel/scripts/typecheck.ts','--emit-client'],returns:[]});
      console.log(JSON.stringify(pinned.expectedSourceManifest));
    }
  } finally { await child.stdin.end(); await child.exited; console.log('lease-released'); }
}
`,
  );
  const expected = await currentCheckSourceManifest(root);
  for (const mode of ['neutral', 'old-cycle']) {
    const file = join(directory, `${mode}.lease`);
    writeFileSync(file, '');
    const child = Bun.spawn([process.execPath, entry, mode, root, file], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
    const identity = processIdentity(child.pid);
    if (!identity || identity.group !== child.pid) {
      child.kill('SIGKILL');
      await child.exited;
      throw new Error('fixture process identity is unavailable');
    }
    expect(identity.group).toBe(child.pid);
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try {
      const readinessDeadline = performance.now() + 5_000;
      while (!existsSync(file + '.ready') && child.exitCode === null && performance.now() < readinessDeadline)
        await Bun.sleep(10);
      expect(existsSync(file + '.ready')).toBe(true);
      const result = await within(child.exited, mode === 'neutral' ? 5_000 : 500);
      if (mode === 'neutral') {
        expect(result).toEqual({ settled: true, value: 0 });
        const output = (await stdout).trim().split('\n');
        expect(output[0]).toBe('source-read-start');
        expect(JSON.parse(output[1]!)).toEqual(expected);
        expect(output.at(-1)).toBe('lease-released');
      } else {
        expect(result.settled).toBe(false);
        expect(
          Bun.spawnSync(['flock', '-n', '-E', '75', file, 'true'], { stdout: 'ignore', stderr: 'ignore' }).exitCode,
        ).toBe(75);
      }
    } finally {
      await cleanup(child, identity);
    }
    if (mode === 'old-cycle') expect(await stdout).toBe('source-read-start\n');
    expect(await stderr).toBe('');
    expect(
      Bun.spawnSync(['flock', '-n', '-E', '75', file, 'true'], { stdout: 'ignore', stderr: 'ignore' }).exitCode,
    ).toBe(0);
  }
  const transport = readFileSync(join(repository, 'scripts/remote-check.ts'), 'utf8');
  expect(transport).not.toContain("import('./check-run.ts')");
}, 15_000);
