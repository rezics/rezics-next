import { createPool } from '../src/database/pool.ts';
import { routeOf } from '../src/route/route.ts';

export function parseBootstrapGovernanceArgs(argv: readonly string[]): { accountId: string } {
  if (argv.length !== 2 || argv[0] !== '--account') {
    throw new Error('Usage: bun services/kernel/scripts/bootstrap-governance.ts --account <id>');
  }
  const accountId = argv[1]!;
  if (accountId.length !== 36 || routeOf(accountId) === null) {
    throw new Error('--account must be a canonical routed UUID');
  }
  return { accountId };
}

async function main(): Promise<void> {
  const { accountId } = parseBootstrapGovernanceArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url?.trim()) throw new Error('DATABASE_URL is required');
  // Root Bun invocations do not load services/kernel/bunfig.toml. Register the
  // native SQL loader explicitly, then import the SQL-bearing module dynamically;
  // a static import would be linked before this runtime registration executes.
  await import('reylo/register');
  // Governance commands record their work through native History, just like the
  // server and worker. Resolve and install that released composition only after
  // registering the SQL loader and before importing the command that uses it.
  const { installNativeHistoryPreload } = await import('../src/composition/preload.ts');
  installNativeHistoryPreload();
  const { configureReceiptKeys, readReceiptKeyRing } = await import('../src/command/receipt-key.ts');
  const { bootstrapGovernance } = await import('../src/access/bootstrap-governance.ts');
  const pool = createPool(url);
  configureReceiptKeys(pool, readReceiptKeyRing());
  try {
    await bootstrapGovernance(pool, accountId);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
