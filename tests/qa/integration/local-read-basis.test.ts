import { expect, test } from 'bun:test';

// These destructive source fixtures run in separate test processes against
// this one disposable QA project. The relay fixture resets its owned graph and
// SQL history after the local-basis fixture has exercised an intentional gap.
test('Local dependency and relay compatibility native fixtures', async () => {
  for (const file of ['services/main/tests/local-read-basis.test.ts', 'services/main/tests/outbox.integration.test.ts']) {
    const child = Bun.spawn([process.execPath, 'test', file], { stdout: 'pipe', stderr: 'pipe', env: process.env });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ file, code, output: stdout + stderr }).toMatchObject({ code: 0 });
  }
}, 240_000);
