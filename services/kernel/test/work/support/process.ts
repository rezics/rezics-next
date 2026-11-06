import { expect } from 'bun:test';
import { workerTestEnv } from '../../support/worker-env.ts';

export function fixture(mode: string) {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/runtime.ts`, mode], {
    env: { ...process.env, ...workerTestEnv() },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  const read = (async () => {
    for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk);
  })();
  const errors = new Response(child.stderr).text();
  return {
    child,
    async until(marker: string) {
      const deadline = Date.now() + 15_000;
      while (!output.includes(marker)) {
        if (child.exitCode !== null || Date.now() > deadline) {
          throw new Error(`Worker did not reach ${marker}: ${output}\n${await errors}`);
        }
        await Bun.sleep(10);
      }
    },
    async finish() {
      expect(await child.exited).toBe(0);
      await read;
      const stderr = await errors;
      expect(stderr).not.toContain('AssertionError');
      return output;
    },
  };
}
