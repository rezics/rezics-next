import { waitFor } from '../goalctl.ts';

try {
  await waitFor(process.argv[2] ?? '', { pollMs: 1, settleMs: 1 });
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
