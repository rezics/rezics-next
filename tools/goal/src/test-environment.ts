import { resolve } from 'node:path';
import { ownedTemporaryDirectory } from '../../../scripts/tmp-janitor.ts';
import { afterAll } from 'bun:test';

// A failed test or runtime marker belongs to this invocation, never the host's shared /tmp.
const temporary = ownedTemporaryDirectory(resolve(import.meta.dir, '../../../.temp/goal-tests'), 'run-');
Object.assign(process.env, temporary.env);
process.once('exit', () => temporary.close());
// Bun's test runner does not emit process.exit on a failed suite.
afterAll(() => temporary.close());

// Root test preloads also route checks, whose wait recorder must see the attempt's file after this preload strips the
// control-plane environment from test processes.
const checkWaitFile = process.env.GOAL_CHECK_WAIT_FILE;
const checkHostsFile = process.env.KERNEL_CHECK_REMOTE;
const handoff = globalThis as typeof globalThis & Record<symbol, unknown>;
if (checkWaitFile !== undefined) {
  handoff[Symbol.for('rezics.goal-check-wait-file')] = checkWaitFile;
}
if (checkHostsFile !== undefined) handoff[Symbol.for('rezics.check-hosts-file')] = checkHostsFile;

// Tests never inherit the store, identity or session of the control plane that launched them: a worker's
// environment names the live database, and a test that spawns the CLI would otherwise act on live tasks.
for (const key of Object.keys(process.env)) if (key.startsWith('GOAL_')) delete process.env[key];
// Train fixtures must opt into affected checks explicitly; package defaults may name live workspace commands.
process.env.REZICS_GOAL_TEST_ENVIRONMENT = '1';
delete process.env.CODEX_THREAD_ID;
// Tests never inherit the host's check routing; a test that wants the remote path sets these variables itself.
delete process.env.KERNEL_CHECK_REMOTE;
delete process.env.KERNEL_CHECK_ON_REMOTE;
// Test repositories live inside the checkout's .temp. Git must not walk up from a test directory into the
// checkout or worktree that runs the tests, where a fake worker's commit would land on a live task branch.
process.env.GIT_CEILING_DIRECTORIES = resolve(import.meta.dir, '../../../.temp/goal-tests');
// Git exports the repository's location to commands it runs (bisect run, rebase --exec, hooks). A test that runs
// `git init` in a temporary directory with those variables would reinitialise the checkout's own repository: a
// bisect over such a test wrote core.bare=true into the shared config. Tests start outside any repository.
for (const key of [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
])
  delete process.env[key];
