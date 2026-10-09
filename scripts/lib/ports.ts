import { createServer } from 'node:net';

function loopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Could not allocate port'));
      server.close(() => resolvePort(address.port));
    });
  });
}
/** One free loopback port per name. A port is never reused inside the set. */
export async function allocatePortSet(names: readonly string[]): Promise<Record<string, number>> {
  const selected = new Set<number>(), ports: Record<string, number> = {};
  for (const name of names) {
    let port: number;
    do { port = await loopbackPort(); } while (selected.has(port));
    selected.add(port);
    ports[name] = port;
  }
  return ports;
}
