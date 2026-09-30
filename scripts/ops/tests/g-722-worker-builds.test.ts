import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { repositoryRoot } from '../migrate.ts';

for (const [app, variable] of [
  ['web', 'MAIN_ORIGIN'],
  ['accounts', 'ACCOUNT_BASE_URL'],
  ['about', 'ABOUT_SITE_URL'],
]) {
  test(`G-722 ${app} production build refuses loopback ${variable}`, () => {
    const result = spawnSync('task', [`${app}:build`], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        CLOUDFLARE_ENV: 'production',
        WEB_OAUTH_CLIENT_ID: 'release-client',
        [variable!]: 'http://127.0.0.1:3000',
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(`Production forbids development ${variable}`);
  }, 60_000);
}
