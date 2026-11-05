import { workerTestEnv } from '../../support/worker-env.ts';

/** A fresh process owns the real default WorkContext and DBOS singleton. */
export async function accountErasureWorker(databaseUrl: string) {
  const program = `
    import { readWorkerConfig,startWorker } from './src/worker.ts';
    console.log('erasure-worker-starting');
    const worker=await startWorker(readWorkerConfig(process.env));
    console.log('erasure-worker-ready');
    process.stdin.once('data',async()=>{console.error('erasure-worker-stopping'); await worker.stop(); console.log('erasure-worker-stopped'); process.stdin.destroy();});
  `;
  const child = Bun.spawn([process.execPath, '-e', program], {
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
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  const stdout = (async () => {
    for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk);
  })();
  let errors = '';
  const stderr = (async () => {
    for await (const chunk of child.stderr) {
      const message = new TextDecoder().decode(chunk);
      errors += message;
      console.error(message);
    }
    return errors;
  })();
  async function until(marker: string) {
    const end = Date.now() + 60_000;
    while (!output.includes(marker)) {
      if (child.exitCode !== null || Date.now() > end)
        throw new Error(`${output}\n${child.exitCode !== null ? await stderr : 'Worker startup did not finish'}`);
      await Bun.sleep(20);
    }
  }
  try {
    await until('erasure-worker-ready');
  } catch (error) {
    // A deliberately blocked native transaction cannot drain on SIGTERM. This fixture owns the process.
    child.kill('SIGKILL');
    await child.exited;
    throw error;
  }
  return {
    async stop() {
      child.stdin.write('stop\n');
      const status = await child.exited;
      await stdout;
      if (status !== 0) throw new Error(`${output}\n${await stderr}`);
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
