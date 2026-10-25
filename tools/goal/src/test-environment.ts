// Tests never inherit the store, identity or session of the control plane that launched them: a worker's
// environment names the live database, and a test that spawns the CLI would otherwise act on live tasks.
for (const key of Object.keys(process.env)) if (key.startsWith('GOAL_')) delete process.env[key];
delete process.env.CODEX_THREAD_ID;
