import { expect, test } from 'bun:test';
import { join } from 'node:path';

const app = join(import.meta.dir, '..');
const fixture = join(import.meta.dir, 'server-render-fixture.tsx');

// Each page renders in a child realm without window, the only environment where a browser read fails on the server.
test.each([
  ['login', 'Sign in'],
  ['security', 'Account security'],
  ['step-up', 'Verify your identity'],
])('%s renders its server document through the root shell without a browser location', async (page, heading) => {
  const child = Bun.spawn(['bun', fixture, page], { cwd: app, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited, stderr).toBe(0);
  expect(stderr).not.toContain('window is not defined');
  const { window, html } = JSON.parse(stdout) as { window: string; html: string };
  expect(window).toBe('undefined');
  // React turns a failed server boundary into a client-render marker; the server document must have none.
  expect(html).not.toContain('<!--$!-->');
  expect(html).toContain('<html lang="en">');
  expect(html).toContain(`>${heading}</h1>`);
});
