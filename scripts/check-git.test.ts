import { afterEach, expect, spyOn, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  stageCheckGit,
  restoreCheckGit,
  releaseCheckGit,
  sweepCheckGit,
  fetchCheckGitScript,
  type CheckGitPublication,
} from './check-git.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function sandbox() {
  const root = mkdtempSync(join(import.meta.dir, '../.temp/rezics-check-git-'));
  roots.push(root);
  return root;
}
function git(cwd: string, ...args: string[]) {
  const run = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10000,
  });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  return run.stdout.toString().trim();
}
function repository(root: string) {
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, 'init', '-q');
  writeFileSync(join(source, '.git/info/exclude'), '.temp/check-git-publications/\n');
  git(source, 'config', 'user.email', 'fixture@example.test');
  git(source, 'config', 'user.name', 'Fixture');
  writeFileSync(join(source, 'tracked.txt'), 'historical\n');
  writeFileSync(join(source, 'staged.txt'), 'old\n');
  git(source, 'add', 'tracked.txt', 'staged.txt');
  git(source, 'commit', '-qm', 'first native commit');
  const historical = git(source, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'tracked.txt'), 'base\n');
  git(source, 'commit', '-qam', 'second native commit');
  const base = git(source, 'rev-parse', 'HEAD');
  git(source, 'branch', 'dev', base);
  writeFileSync(join(source, 'tracked.txt'), 'committed\n');
  git(source, 'commit', '-qam', 'third native commit');
  const head = git(source, 'rev-parse', 'HEAD');
  return { source, historical, base, head };
}
function copyWorkingFiles(source: string, target: string) {
  mkdirSync(target);
  for (const file of ['tracked.txt', 'staged.txt', 'untracked.txt']) {
    if (existsSync(join(source, file))) cpSync(join(source, file), join(target, file));
  }
}

test('native check Git custody retains the candidate and base as shallow history with independent worktree creation', async () => {
  const root = sandbox();
  const { source, historical, base, head } = repository(root);
  const linked = join(root, 'linked-source');
  git(source, 'worktree', 'add', '--detach', linked, head);
  writeFileSync(join(linked, 'staged.txt'), 'staged\n');
  git(linked, 'add', 'staged.txt');
  writeFileSync(join(linked, 'tracked.txt'), 'unstaged\n');
  writeFileSync(join(linked, 'untracked.txt'), 'new\n');
  git(source, 'config', 'remote.private.url', 'https://secret.invalid/credential-must-not-travel');
  const original = git(linked, 'status', '--porcelain=v1');
  const artifacts = join(root, 'artifacts');
  mkdirSync(artifacts);
  const manifest = await stageCheckGit(linked, artifacts);
  const transferred = join(root, 'transferred');
  cpSync(artifacts, transferred, { recursive: true });
  const copiedManifest = join(transferred, manifest.slice(artifacts.length + 1));
  expect(dirname(manifest).startsWith(artifacts)).toBe(true);
  expect(git(linked, 'status', '--porcelain=v1')).toBe(original);
  const checkout = join(root, 'remote');
  copyWorkingFiles(linked, checkout);
  rmSync(linked, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
  rmSync(artifacts, { recursive: true, force: true });
  await restoreCheckGit(copiedManifest, checkout);
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(checkout, 'rev-parse', '--is-shallow-repository')).toBe('true');
  expect(git(checkout, 'merge-base', 'dev', 'HEAD')).toBe(base);
  expect(git(checkout, 'diff', '--name-only', 'dev...HEAD')).toBe('tracked.txt');
  expect(git(checkout, 'rev-list', '--all')).not.toContain(historical);
  expect(git(checkout, 'status', '--porcelain=v1')).toBe(original);
  expect(readFileSync(join(checkout, 'tracked.txt'), 'utf8')).toBe('unstaged\n');
  expect(git(checkout, 'config', '--local', '--list')).not.toContain('credential-must-not-travel');
  const child = join(root, 'native-child');
  git(checkout, 'worktree', 'add', '--detach', child, 'HEAD');
  expect(readFileSync(join(child, 'tracked.txt'), 'utf8')).toBe('committed\n');
  git(checkout, 'worktree', 'remove', child);
}, 30000);

test('native check Git custody gives concurrent physical runs independent mutable indexes', async () => {
  const root = sandbox();
  const { source, head } = repository(root);
  git(source, 'branch', '-D', 'dev');
  writeFileSync(join(source, 'untracked.txt'), 'separate\n');
  const inputs = [join(root, 'input-one'), join(root, 'input-two')];
  for (const input of inputs) mkdirSync(input);
  const manifests = await Promise.all(inputs.map((input) => stageCheckGit(source, input)));
  const snapshot = JSON.parse(readFileSync(manifests[0]!, 'utf8')) as { dev: string | null; shallow: string };
  expect(snapshot.dev).toBeNull();
  expect(snapshot.shallow).toBe(head);
  const targets = [join(root, 'run-one'), join(root, 'run-two')];
  for (const target of targets) copyWorkingFiles(source, target);
  await Promise.all(targets.map((target, index) => restoreCheckGit(manifests[index]!, target)));
  expect(git(targets[0]!, 'rev-parse', '--is-shallow-repository')).toBe('true');
  writeFileSync(join(targets[0]!, 'tracked.txt'), 'only run one\n');
  git(targets[0]!, 'add', 'tracked.txt');
  expect(git(targets[0]!, 'diff', '--cached', '--name-only')).toBe('tracked.txt');
  expect(git(targets[1]!, 'diff', '--cached', '--name-only')).toBe('');
  expect(git(source, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(source, 'diff', '--cached', '--name-only')).toBe('');
  expect(readFileSync(join(targets[1]!, 'tracked.txt'), 'utf8')).toBe('committed\n');
}, 30000);

test('native check Git custody rejects a corrupt manifest before publishing a usable repository', async () => {
  const root = sandbox();
  const { source } = repository(root);
  const artifacts = join(root, 'artifacts');
  mkdirSync(artifacts);
  const manifest = await stageCheckGit(source, artifacts);
  writeFileSync(manifest, 'corrupt incomplete snapshot\n');
  const checkout = join(root, 'remote');
  copyWorkingFiles(source, checkout);
  await expect(restoreCheckGit(manifest, checkout)).rejects.toThrow();
  expect(readFileSync(join(checkout, 'tracked.txt'), 'utf8')).toBe('committed\n');
  expect(existsSync(join(checkout, '.git'))).toBe(false);
}, 30000);

function publicOrigin(root: string, source: string) {
  const origin = join(root, 'origin.git');
  git(root, 'init', '--bare', '-q', origin);
  git(source, 'remote', 'add', 'origin', origin);
  git(source, 'push', '-q', 'origin', 'HEAD:refs/heads/dev');
  return origin;
}
function fetchPublication(publication: CheckGitPublication, checkout: string, store: string, origin: string) {
  return Bun.spawnSync(['sh', '-c', fetchCheckGitScript(publication, checkout, store, origin)], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30000,
  });
}

test('a check-only publication sends only new objects and both hosts restore the exact native identities', async () => {
  const root = sandbox();
  const { source, base } = repository(root);
  writeFileSync(join(source, 'large.bin'), randomBytes(128000));
  git(source, 'add', 'large.bin');
  git(source, 'commit', '-qm', 'shared public objects');
  const head = git(source, 'rev-parse', 'HEAD');
  const origin = publicOrigin(root, source);
  const previous = new Set(
    git(root, '--git-dir', origin, 'rev-list', '--objects', '--all')
      .split('\n')
      .map((line) => line.split(' ')[0]),
  );
  writeFileSync(join(source, 'staged.txt'), 'staged candidate\n');
  git(source, 'add', 'staged.txt');
  const indexTree = git(source, 'write-tree');
  const status = git(source, 'status', '--porcelain');
  const manifestPath = await stageCheckGit(source, join(root, 'publication'), { ref: 'refs/checks/worker-check' });
  const publication = JSON.parse(readFileSync(manifestPath, 'utf8')) as CheckGitPublication;
  expect(publication.remote.ref).toBe('refs/checks/worker-check');
  expect(git(root, '--git-dir', origin, 'rev-parse', 'refs/heads/dev')).toBe(head);
  const added = git(root, '--git-dir', origin, 'rev-list', '--objects', '--all')
    .split('\n')
    .map((line) => line.split(' ')[0]!)
    .filter((oid) => !previous.has(oid));
  expect(added).toHaveLength(3); // candidate commit, staged tree and changed blob; history is already public.
  const bytes = added.reduce(
    (sum, oid) => sum + statSync(join(origin, 'objects', oid.slice(0, 2), oid.slice(2))).size,
    0,
  );
  expect(bytes).toBeLessThan(2048);
  for (const host of ['host-one', 'host-two']) {
    const checkout = join(root, host, 'runs', 'worker-check');
    const store = join(root, host, 'check-git.git');
    const restored = fetchPublication(publication, checkout, store, origin);
    expect(restored.exitCode, restored.stderr.toString()).toBe(0);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(checkout, 'write-tree')).toBe(indexTree);
    expect(git(checkout, 'rev-parse', 'dev')).toBe(base);
    expect(readFileSync(join(checkout, 'staged.txt'), 'utf8')).toBe('staged candidate\n');
    expect(readFileSync(join(checkout, '.git/objects/info/alternates'), 'utf8').trim()).toBe(join(store, 'objects'));
  }
  expect(git(source, 'status', '--porcelain')).toBe(status);
  await releaseCheckGit(source, manifestPath);
  expect(git(root, '--git-dir', origin, 'for-each-ref', '--format=%(refname)', 'refs/checks/')).toBe('');
}, 30000);

test.each(['push', 'fetch'])(
  '%s failure falls back to a full snapshot with identical HEAD, index and dev',
  async (failure) => {
    const root = sandbox();
    const { source, head, base } = repository(root);
    const origin = publicOrigin(root, source);
    writeFileSync(join(source, 'staged.txt'), 'staged\n');
    git(source, 'add', 'staged.txt');
    const indexTree = git(source, 'write-tree');
    writeFileSync(join(source, 'tracked.txt'), 'unstaged\n');
    if (failure === 'push') git(source, 'remote', 'set-url', 'origin', join(root, 'unreachable.git'));
    const published = await stageCheckGit(source, join(root, 'publication'), { ref: 'refs/checks/fallback' });
    let manifest = published;
    if (failure === 'fetch') {
      const publication = JSON.parse(readFileSync(published, 'utf8')) as CheckGitPublication;
      const result = fetchPublication(
        publication,
        join(root, 'failed-fetch'),
        join(root, 'store.git'),
        join(root, 'unreachable.git'),
      );
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(join(root, 'failed-fetch/.git'))).toBe(false);
      manifest = await stageCheckGit(source, join(root, 'fallback'));
    }
    expect(existsSync(join(dirname(manifest), 'snapshot.pack'))).toBe(true);
    const checkout = join(root, 'restored');
    copyWorkingFiles(source, checkout);
    await restoreCheckGit(manifest, checkout);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(checkout, 'write-tree')).toBe(indexTree);
    expect(git(checkout, 'rev-parse', 'dev')).toBe(base);
    expect(git(checkout, 'status', '--porcelain')).toBe(git(source, 'status', '--porcelain'));
    if (failure === 'fetch') await releaseCheckGit(source, published);
  },
  30000,
);

test('private key material in the staged tree is refused before a ref can be pushed', async () => {
  const root = sandbox();
  const { source } = repository(root);
  const origin = publicOrigin(root, source);
  writeFileSync(join(source, 'staged.txt'), ['-----BEGIN', 'PRIVATE KEY-----'].join(' '));
  git(source, 'add', 'staged.txt');
  writeFileSync(join(source, 'staged.txt'), 'innocent working file\n');
  await expect(stageCheckGit(source, join(root, 'publication'), { ref: 'refs/checks/secret' })).rejects.toThrow(
    'private key',
  );
  expect(git(root, '--git-dir', origin, 'for-each-ref', '--format=%(refname)', 'refs/checks/')).toBe('');
});

function publicationFixture(hook: string) {
  const root = sandbox();
  const { source } = repository(root);
  const origin = publicOrigin(root, source);
  const log = join(root, 'pushes');
  const receive = join(origin, 'hooks/pre-receive');
  writeFileSync(receive, `#!/bin/sh\ncat >> '${log}'\n${hook}\n`);
  chmodSync(receive, 0o755);
  return { root, source, origin, log };
}

test('one failed push retries the identical candidate and retains redacted transport diagnostics', async () => {
  const { root, source, origin, log } = publicationFixture(
    `if [ "$(wc -l < '../pushes')" -eq 1 ]; then echo 'fatal: gateway https://user:credential@github.test/repo?token=private authorization: Bearer hidden' >&2; exit 1; fi`,
  );
  const errors: string[] = [];
  const output = spyOn(console, 'error').mockImplementation((message) => {
    errors.push(String(message));
  });
  try {
    const path = await stageCheckGit(source, join(root, 'publication'), {
      ref: 'refs/checks/retry',
      backoff: async () => {},
    });
    const publication = JSON.parse(readFileSync(path, 'utf8')) as CheckGitPublication;
    const pushes = readFileSync(log, 'utf8').trim().split('\n');
    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toBe(pushes[1]);
    expect(pushes[0]).toContain(publication.remote.commit);
    expect(git(root, '--git-dir', origin, 'rev-parse', publication.remote.ref)).toBe(publication.remote.commit);
    expect(errors.join('\n')).toContain('exit 1');
    expect(errors.join('\n')).toContain('gateway');
    expect(errors.join('\n')).not.toMatch(/credential@|token=private|hidden/);
    await releaseCheckGit(source, path);
  } finally {
    output.mockRestore();
  }
});

test.each([false, true])('final push failure keeps stderr and snapshot fallback; expired retry=%s', async (expire) => {
  const { root, source, log } = publicationFixture(`echo 'fatal: gateway unavailable' >&2; exit 1`);
  const errors: string[] = [];
  const output = spyOn(console, 'error').mockImplementation((message) => {
    errors.push(String(message));
  });
  let clock = 0;
  try {
    const manifest = await stageCheckGit(source, join(root, 'publication'), {
      ref: 'refs/checks/final-failure',
      deadlineMs: 1000,
      now: () => clock,
      backoff: async () => {
        if (expire) clock = 1000;
      },
    });
    expect(existsSync(join(dirname(manifest), 'snapshot.pack'))).toBe(true);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(expire ? 1 : 2);
    expect(errors.join('\n')).toContain('gateway unavailable');
    expect(errors.join('\n')).toContain(expire ? 'deadline exceeded' : 'exit 1');
    expect(errors.join('\n')).toContain('using full snapshot upload');
  } finally {
    output.mockRestore();
  }
});

test('failed manifest delivery releases a published ref using the earlier intent', async () => {
  const { root, source, origin } = publicationFixture('exit 0');
  const artifacts = join(root, 'publication');
  // The receiving hook simulates a local manifest write failure after the server accepted the candidate.
  writeFileSync(join(origin, 'hooks/post-receive'), `#!/bin/sh\nmkdir '${artifacts}/manifest.json'\n`);
  chmodSync(join(origin, 'hooks/post-receive'), 0o755);
  await expect(stageCheckGit(source, artifacts, { ref: 'refs/checks/interrupted' })).rejects.toThrow();
  const journal = join(source, '.temp/check-git-publications/interrupted.json');
  if (existsSync(journal)) await releaseCheckGit(source, journal);
  expect(git(root, '--git-dir', origin, 'for-each-ref', '--format=%(refname)', 'refs/checks/')).toBe('');
});

test('stale sweep deletes only settled owned identities and preserves active, frozen and foreign refs', async () => {
  const root = sandbox();
  const { source, head } = repository(root);
  const origin = publicOrigin(root, source);
  for (const name of ['stale', 'active', 'retained', 'replaced', 'foreign', 'recent', 'unknown']) {
    const path = await stageCheckGit(source, join(root, name), {
      ref: `refs/checks/${name}`,
      retain: name === 'retained',
    });
    const journal = join(source, `.temp/check-git-publications/${name}.json`);
    const record = JSON.parse(readFileSync(journal, 'utf8'));
    record.ownership.createdAt = name === 'recent' ? 10 * 86400000 : 0;
    if (!['active', 'retained', 'unknown'].includes(name)) record.ownership.state = 'releasable';
    if (name === 'foreign') record.remote.ref = 'refs/heads/dev';
    if (name === 'unknown') delete record.ownership;
    writeFileSync(journal, JSON.stringify(record));
    if (name === 'replaced') git(source, 'push', '-q', '--force', 'origin', `${head}:refs/checks/replaced`);
    if (name === 'retained') await releaseCheckGit(source, path);
  }
  git(
    source,
    'push',
    '-q',
    'origin',
    `${head}:refs/heads/main`,
    `${head}:refs/tags/keep`,
    `${head}:refs/other/foreign`,
  );
  await sweepCheckGit(source, 10 * 86400000);
  const refs = git(root, '--git-dir', origin, 'for-each-ref', '--format=%(refname)');
  expect(refs).not.toContain('refs/checks/stale');
  for (const ref of ['active', 'retained', 'replaced', 'foreign', 'recent', 'unknown'])
    expect(refs).toContain(`refs/checks/${ref}`);
  for (const ref of ['refs/heads/dev', 'refs/heads/main', 'refs/tags/keep', 'refs/other/foreign'])
    expect(refs).toContain(ref);
  await releaseCheckGit(source, join(root, 'retained/manifest.json'), { settled: true });
  expect(git(root, '--git-dir', origin, 'for-each-ref', '--format=%(refname)', 'refs/checks/retained')).toBe('');
});

test('a lost push response falls back and releases the exact remotely accepted candidate', async () => {
  const { root, source, origin } = publicationFixture('exit 0');
  const receiver = join(root, 'receive');
  const requests = join(root, 'requests');
  writeFileSync(receiver, `#!/bin/sh\nprintf 'request\\n' >> '${requests}'\ngit-receive-pack "$@"\nexit 1\n`);
  chmodSync(receiver, 0o755);
  git(source, 'config', 'remote.origin.receivepack', receiver);
  const manifest = await stageCheckGit(source, join(root, 'publication'), {
    ref: 'refs/checks/lost-response',
    backoff: async () => {},
  });
  expect(existsSync(join(dirname(manifest), 'snapshot.pack'))).toBe(true);
  expect(readFileSync(requests, 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(2);
  const journal = join(source, '.temp/check-git-publications/lost-response.json');
  if (existsSync(journal)) await releaseCheckGit(source, journal);
  expect(git(root, '--git-dir', origin, 'for-each-ref', '--format=%(refname)', 'refs/checks/')).toBe('');
});

test('an unavailable ownership journal falls back without publishing or releasing another ref', async () => {
  const root = sandbox();
  const { source } = repository(root);
  const origin = publicOrigin(root, source);
  mkdirSync(join(source, '.temp'));
  writeFileSync(join(source, '.temp/check-git-publications'), 'unavailable');
  const manifest = await stageCheckGit(source, join(root, 'publication'), { ref: 'refs/checks/no-journal' });
  expect(existsSync(join(dirname(manifest), 'snapshot.pack'))).toBe(true);
  expect(git(root, '--git-dir', origin, 'for-each-ref', '--format=%(refname)', 'refs/checks/')).toBe('');
  rmSync(join(source, '.temp/check-git-publications'));
  const owned = await stageCheckGit(source, join(root, 'owned'), { ref: 'refs/checks/existing' });
  const candidate = git(root, '--git-dir', origin, 'rev-parse', 'refs/checks/existing');
  const fallback = await stageCheckGit(source, join(root, 'duplicate'), { ref: 'refs/checks/existing' });
  expect(existsSync(join(dirname(fallback), 'snapshot.pack'))).toBe(true);
  expect(git(root, '--git-dir', origin, 'rev-parse', 'refs/checks/existing')).toBe(candidate);
  await releaseCheckGit(source, owned);
});
