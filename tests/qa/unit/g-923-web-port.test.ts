import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { allocateWebPort } from '../../../scripts/qa/e2e.ts';

function portTaken(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((resolveTaken) => {
    server.once('error', () => resolveTaken(true));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolveTaken(false));
    });
  });
}

async function waitUntilFree(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await portTaken(port))) return;
    await Bun.sleep(20);
  }
  throw new Error(`port ${port} stayed occupied`);
}

test('two web port allocations in one process return different free ports', async () => {
  const first = await allocateWebPort();
  const second = await allocateWebPort();
  try {
    expect(first.port).not.toBe(second.port);
    expect(first.port).toBeGreaterThan(0);
    expect(second.port).toBeGreaterThan(0);
    expect(first.port).toBeLessThanOrEqual(65535);
    expect(second.port).toBeLessThanOrEqual(65535);
    expect(await portTaken(first.port)).toBe(true);
    expect(await portTaken(second.port)).toBe(true);
  } finally {
    first.release();
    second.release();
  }
  await waitUntilFree(first.port);
  await waitUntilFree(second.port);
});
