import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createWorkerPersistence } from './worker-persistence.ts';

const repositoryRoot = resolve(import.meta.dir, '..');

test('owns temporary Worker persistence per config and preserves caller and sibling paths', () => {
  const commonRoot = mkdtempSync(join(tmpdir(), 'rezics-worker-persistence-test-root-'));
  const callerRoot = mkdtempSync(join(tmpdir(), 'rezics-worker-persistence-caller-'));
  const callerMarker = join(callerRoot, 'caller.txt');
  writeFileSync(callerMarker, 'caller-owned');
  let web: ReturnType<typeof createWorkerPersistence> | undefined;
  let sibling: ReturnType<typeof createWorkerPersistence> | undefined;
  let auth: ReturnType<typeof createWorkerPersistence> | undefined;
  let replaced: ReturnType<typeof createWorkerPersistence> | undefined;
  let replacement: string | undefined;
  const environment = { WEB_TEST_STATE_DIR: commonRoot, REZICS_TEST_RUNTIME: '1' };
  try {
    const webContext = { command: 'serve' };
    const siblingContext = { command: 'serve' };
    const authContext = { command: 'serve' };
    web = createWorkerPersistence('web', webContext, repositoryRoot, environment);
    sibling = createWorkerPersistence('web', siblingContext, repositoryRoot, environment);
    auth = createWorkerPersistence('auth', authContext, repositoryRoot, environment);
    expect(createWorkerPersistence('web', webContext, repositoryRoot, environment)).toBe(web);
    expect(web.directory).not.toBe(sibling.directory);
    expect(web.directory).not.toBe(auth.directory);
    expect(web.effectiveDirectory).toBe(resolve(web.directory!, 'v3'));
    expect(realpathSync(tmpdir())).toBe(dirname(realpathSync(web.directory!)));
    expect(basename(web.directory!)).toStartWith('rezics-web-worker-');
    expect(basename(auth.directory!)).toStartWith('rezics-auth-worker-');

    const explicit = createWorkerPersistence('web', { command: 'serve' }, repositoryRoot, {
      ...environment,
      WEB_TEST_STATE_INSTANCE_DIR: callerRoot,
    });
    expect(explicit.owned).toBe(false);
    expect(explicit.directory).toBe(callerRoot);
    explicit.cleanup();
    expect(readFileSync(callerMarker, 'utf8')).toBe('caller-owned');

    replaced = createWorkerPersistence('web', { command: 'serve' }, repositoryRoot, environment);
    replacement = mkdtempSync(join(tmpdir(), 'rezics-worker-persistence-sibling-'));
    const siblingMarker = join(replacement, 'keep.txt');
    writeFileSync(siblingMarker, 'sibling-owned');
    rmSync(replaced.directory!, { recursive: true, force: true });
    symlinkSync(replacement, replaced.directory!, 'dir');
    replaced.cleanup();
    expect(existsSync(replaced.directory!)).toBe(true);
    expect(readFileSync(siblingMarker, 'utf8')).toBe('sibling-owned');

    web.cleanup();
    web.cleanup();
    expect(existsSync(web.directory!)).toBe(false);
    expect(existsSync(sibling.directory!)).toBe(true);
    expect(existsSync(auth.directory!)).toBe(true);
    sibling.cleanup();
    auth.cleanup();
    expect(existsSync(sibling.directory!)).toBe(false);
    expect(existsSync(auth.directory!)).toBe(false);
    expect(readFileSync(callerMarker, 'utf8')).toBe('caller-owned');
  } finally {
    web?.cleanup();
    sibling?.cleanup();
    auth?.cleanup();
    replaced?.cleanup();
    if (replaced?.directory && existsSync(replaced.directory)) rmSync(replaced.directory, { force: true });
    if (replacement) rmSync(replacement, { recursive: true, force: true });
    rmSync(callerRoot, { recursive: true, force: true });
    rmSync(commonRoot, { recursive: true, force: true });
  }
});
