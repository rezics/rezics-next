import { workerTestEnv } from '../../support/worker-env.ts';

/** A fresh process owns the real default WorkContext and DBOS singleton. */
export async function accountErasureWorker(databaseUrl: string) {
  const child = Bun.spawn([process.execPath, 'src/worker.ts'], {
    cwd: `${import.meta.dir}/../../..`,
    env: {
      ...process.env,
      ...workerTestEnv(),
      DATABASE_URL: databaseUrl,
      KERNEL_EXECUTOR_ID: 'semantic-erasure-native',
      STRIPE_SECRET_KEY: 'sk_test_semantic_erasure',
      STRIPE_MANAGED_PAYMENTS: 'false',
      CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
      CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  const stdout = (async () => {
    for await (const chunk of child.stdout) output = (output + new TextDecoder().decode(chunk)).slice(-24_000);
  })();
  let errors = '';
  const stderr = (async () => {
    for await (const chunk of child.stderr) {
      const message = new TextDecoder().decode(chunk);
      errors = (errors + message).slice(-24_000);
      console.error(message);
    }
    return errors;
  })();
  async function until(marker: string) {
    const end = Date.now() + 180_000;
    while (!output.includes(marker) && !errors.includes(marker)) {
      if (child.exitCode !== null || Date.now() > end)
        throw new Error(
          `${output}\n${errors || (child.exitCode !== null ? await stderr : 'Worker startup did not finish')}`,
        );
      await Bun.sleep(20);
    }
  }
  try {
    await until('Worker ready');
  } catch (error) {
    // A deliberately blocked native transaction cannot drain on SIGTERM. This fixture owns the process.
    child.kill('SIGKILL');
    await child.exited;
    throw error;
  }
  return {
    async stop() {
      let expired = false;
      const guard = setTimeout(() => {
        expired = true;
        child.kill('SIGKILL');
      }, 10_000);
      try {
        if (child.exitCode === null) {
          child.kill('SIGTERM');
        }
        const status = await child.exited;
        await Promise.all([stdout, stderr]);
        if (expired || status !== 0)
          throw new Error(
            `Erasure worker stop: exit=${status} signal=${child.signalCode} timeout=${expired}\n${output.slice(-8000)}\n${errors.slice(-16000)}`,
          );
      } finally {
        clearTimeout(guard);
      }
    },
    async crash() {
      child.kill('SIGKILL');
      await child.exited;
      await stdout;
      const errors = `${output}\n${await stderr}`;
      if (/error|failed|stopped at/i.test(errors)) console.error(errors.slice(-24000));
    },
  };
}
