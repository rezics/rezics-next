import { expect, test } from 'bun:test';

async function storageBindings(local: boolean) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development' };
  delete env.WEBSITE_CONFIGURATION_FILE;
  delete env.LOCAL_MEDIA_ORIGIN;
  delete env.LOCAL_MEDIA_TOKEN;
  if (local) {
    env.LOCAL_MEDIA_ORIGIN = 'http://127.0.0.1:41234';
    env.LOCAL_MEDIA_TOKEN = 'private-test-transport';
  }
  const child = Bun.spawn(
    [
      'bun', '-e', `
      import configuration from './cloudflare.config.ts';
      const { MEDIA, LOCAL_MEDIA_ORIGIN, LOCAL_MEDIA_TOKEN } = configuration.worker.env;
      process.stdout.write(JSON.stringify({ MEDIA, LOCAL_MEDIA_ORIGIN, LOCAL_MEDIA_TOKEN }));
    `,
    ],
    { cwd: new URL('..', import.meta.url).pathname, env, stdout: 'pipe', stderr: 'pipe' },
  );
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(error).toBe('');
  expect(code).toBe(0);
  return JSON.parse(output);
}

test('the default Worker retains R2 media storage', async () => {
  expect(await storageBindings(false)).toEqual({ MEDIA: { type: 'r2', name: 'rezics-media', dev: { remote: false } } });
});

test('the local stack selects the native object origin and private credential instead of a separate R2 bucket', async () => {
  expect(await storageBindings(true)).toEqual({
    LOCAL_MEDIA_ORIGIN: { type: 'text', value: 'http://127.0.0.1:41234' },
    LOCAL_MEDIA_TOKEN: { type: 'secret' },
  });
});
