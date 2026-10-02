import {
  checkProductionEnv,
  assertNoPaymentProvider,
  type ProductionRole,
} from '../../scripts/ops/production-env.ts';

const entrypoints = {
  main: 'services/main/src/index.ts',
  relay: 'services/main/src/relay.ts',
  'relay-init': 'services/main/src/relay-init.ts',
  account: 'services/account/src/index.ts',
  migrate: 'scripts/ops/migrate.ts',
} as const;
const role = process.argv[2] ?? process.env.REZICS_ROLE ?? 'main';
if (!Object.hasOwn(entrypoints, role)) throw new Error('Unknown release runtime role');
checkProductionEnv(process.env, [role as ProductionRole]);
if (process.env.ACCESS_DATABASE_URL)
  await assertNoPaymentProvider(process.env.ACCESS_DATABASE_URL, role === 'migrate');
const preload = role === 'main' ? './services/main/src/telemetry.ts'
  : role === 'account' ? './services/account/src/telemetry.ts'
    : role === 'relay' ? './services/main/src/relay-telemetry.ts' : undefined;
const child = Bun.spawn([process.execPath, ...(preload ? ['--preload', preload] : []), entrypoints[role as keyof typeof entrypoints]], {
  env: { ...process.env, OTEL_DEPLOYMENT_ENVIRONMENT: process.env.OTEL_DEPLOYMENT_ENVIRONMENT ?? 'production' },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
process.exit(await child.exited);
