import { composeWork } from '../../../src/work/registry.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { createPool } from '../../../src/database/pool.ts';
import { createCommerceWork } from '../../../src/commerce/work.ts';
import { createStripePort } from '../../../src/commerce/stripe.ts';

// Advance the SDK clock on process recovery, leaving PostgreSQL's authoritative clock untouched.
const realNow = Date.now;
const offset = Number(process.env.WORK_CLOCK_OFFSET ?? 0);
Date.now = () => realNow() + offset;
const databaseUrl = process.env.DATABASE_URL!;
const pool = createPool(databaseUrl);
const client = await createWorkClient(databaseUrl);
const stripe = createStripePort({
  apiKey: 'sk_test_work',
  managedPayments: false,
  host: '127.0.0.1',
  port: Number(process.env.WORK_STRIPE_PORT),
  protocol: 'http',
  maxNetworkRetries: 0,
  clock: () => new Date('2000-01-01T00:00:00Z'),
});
const worker = await composeWork(
  [
    createCommerceWork({
      stripe,
      checkout: {
        successUrl: process.env.WORK_SUCCESS_URL ?? 'https://example.test/success',
        cancelUrl: process.env.WORK_CANCEL_URL ?? 'https://example.test/cancel',
      },
    }),
  ],
  { pool, client, databaseUrl, executorId: 'commerce-test' },
);
await worker.launch();
console.log('ready');
