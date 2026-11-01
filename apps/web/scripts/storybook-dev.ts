import { resolve } from 'node:path';
import { requireWebCheckCustody } from './check-placement.ts';

/** Interactive listeners need a real remote access/tunnel and durable long-running custody API. */
export function unavailableInteractiveCheck(): never {
  throw new Error('Interactive Web/Storybook development is unavailable: the remote check interface supports finite commands only; remote access/tunnel and durable listener custody are not available.');
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args[0] !== '--web' || process.env.REZICS_TEST_RUNTIME !== '1') unavailableInteractiveCheck();
    // A finite browser check's Vite child uses its existing fixture/group cleanup on the physical host.
    // This grants no standalone interactive access, even when a caller forges the test-runtime marker.
    const app = resolve(import.meta.dir, '..');
    requireWebCheckCustody(resolve(app, '../..'), app);
    const child = Bun.spawn(['vite', '--config', 'vite.config.ts', ...args.slice(1)], {
      cwd: app, env: process.env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
    });
    const forwarders = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => {
      const forward = () => child.kill(signal);
      process.on(signal, forward);
      return [signal, forward] as const;
    });
    try { process.exitCode = await child.exited; }
    finally { for (const [signal, forward] of forwarders) process.off(signal, forward); }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 75;
  }
}
