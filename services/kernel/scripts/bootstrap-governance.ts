import 'reylo/register';
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
  // Load command SQL only after the repository's Reylo runtime has registered.
  const { bootstrapGovernance } = await import('../src/access/bootstrap-governance.ts');
  const pool = createPool(url);
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
