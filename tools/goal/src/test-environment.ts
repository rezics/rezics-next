import { resolve } from 'node:path';

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
delete process.env.CODEX_THREAD_ID;
// Tests never inherit the host's check routing; a test that wants the remote path sets these variables itself.
delete process.env.KERNEL_CHECK_REMOTE;
delete process.env.KERNEL_CHECK_ON_REMOTE;
// Test repositories live inside the checkout's .temp. Git must not walk up from a test directory into the
// checkout or worktree that runs the tests, where a fake worker's commit would land on a live task branch.
process.env.GIT_CEILING_DIRECTORIES = resolve(import.meta.dir, '../../../.temp/goal-tests');
