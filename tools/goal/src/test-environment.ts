import { resolve } from 'node:path';

// Tests never inherit the store, identity or session of the control plane that launched them: a worker's
// environment names the live database, and a test that spawns the CLI would otherwise act on live tasks.
for (const key of Object.keys(process.env)) if (key.startsWith('GOAL_')) delete process.env[key];
delete process.env.CODEX_THREAD_ID;
// Test repositories live inside the checkout's .temp. Git must not walk up from a test directory into the
// checkout or worktree that runs the tests, where a fake worker's commit would land on a live task branch.
process.env.GIT_CEILING_DIRECTORIES = resolve(import.meta.dir, '../../../.temp/goal-tests');
