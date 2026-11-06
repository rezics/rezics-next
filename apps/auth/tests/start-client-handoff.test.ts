import { expect, test } from 'bun:test';
import { join } from 'node:path';

const app = join(import.meta.dir, '..');
const fixture = join(import.meta.dir, 'start-client-fixture.tsx');
const login =
  '/login?response_type=code&client_id=rezics-website&redirect_uri=https%3A%2F%2Fweb.rezics.test%2Fauth%2Fcallback' +
  '&scope=openid&state=opaque&nonce=n&code_challenge=c&code_challenge_method=S256';

// Each captured dev-server document is mounted by the real StartClient in its own process, at its own location.
test.each([
  ['login', login, 'Sign in'],
  ['security', '/security', 'Account security'],
  ['step-up', '/step-up?return_to=%2Fsecurity', 'Verify your identity'],
] as const)('the %s server document hydrates through the Start client', async (name, path, heading) => {
  const child = Bun.spawn(['bun', fixture, name, path], { cwd: app, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited, stderr).toBe(0);
  const line = stdout.split('\n').find((text) => text.startsWith('RESULT '));
  expect(line, stdout).toBeDefined();
  const result = JSON.parse(line!.slice('RESULT '.length)) as {
    hydrated: boolean;
    heading: string | null;
    errors: string[];
    logs: string[];
  };
  // A failed server boundary reports "Switched to client rendering" here, so the server render must be clean.
  expect(result.errors).toEqual([]);
  expect(result.logs).toEqual([]);
  expect(result.hydrated).toBe(true);
  expect(result.heading).toBe(heading);
});
