import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const special of ['dump', 'key'] as const) {
  test(`ordinary CLI rejects a ${special} FIFO without a writer or effects`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imports-special-file-'));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const fifo = join(dir, 'unopened.pipe');
      expect(await Bun.spawn(['mkfifo', fifo]).exited).toBe(0);
      const dump = join(dir, 'source.jsonl');
      await writeFile(dump, '{"id":1,"type":1,"name":"Book"}\n');
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const key = join(dir, 'account.jwk');
      await writeFile(
        key,
        JSON.stringify({ ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), alg: 'ES256', kid: 'fixture' }),
        { mode: 0o600 },
      );
      const state = join(dir, 'state.sqlite');
      const args = [
        '--source',
        'bangumi',
        '--dump',
        special === 'dump' ? fifo : dump,
        '--state',
        state,
        '--api',
        'https://api.rezics.test',
        '--account-key',
        special === 'key' ? fifo : key,
        '--account',
        '00000000-0000-4000-8000-000000000001',
        '--client',
        'rezics-importer',
        '--auth',
        'https://auth.rezics.test',
      ];
      const module = new URL('../src/cli.ts', import.meta.url).href;
      const script = `const { runImportCli } = await import(${JSON.stringify(module)}); let requests=0, databases=0; const result=await runImportCli(${JSON.stringify(args)}, {fetch: async()=>{requests++;throw new Error('Network forbidden');}, observer:{onDatabaseOpen(){databases++;}}}); console.log(JSON.stringify({result,requests,databases}));`;
      child = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
      const completed = await Promise.race([
        child.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
      if (!completed) {
        child.kill('SIGKILL');
        await child.exited;
      }
      expect(completed).toBe(true);
      expect(child.exitCode).toBe(0);
      const observation = JSON.parse(await new Response(child.stdout).text());
      expect(observation.result.code).toBe(2);
      expect(observation.result.openHandles).toBe(0);
      expect(observation.requests).toBe(0);
      expect(observation.databases).toBe(0);
      expect(
        await stat(state).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    } finally {
      if (timer) clearTimeout(timer);
      if (child && child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 10000);
}
