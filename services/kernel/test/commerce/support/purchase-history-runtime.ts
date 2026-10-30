import { createPool } from '../../../src/database/pool.ts';
import { createStripePort } from '../../../src/commerce/stripe.ts';
import { createCommerceWork } from '../../../src/commerce/work.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { composeWork } from '../../../src/work/registry.ts';

const databaseUrl = process.env.DATABASE_URL!;
const pool = createPool(databaseUrl);
const client = await createWorkClient(databaseUrl);
const stripe = createStripePort({
  apiKey: 'sk_test_history',
  managedPayments: false,
  host: '127.0.0.1',
  port: Number(process.env.WORK_STRIPE_PORT),
  protocol: 'http',
  maxNetworkRetries: 0,
  clock: () => new Date(),
});
const work = await composeWork(
  [
    createCommerceWork({
      stripe,
      checkout: { successUrl: 'https://web.test/orders/{ORDER_ID}', cancelUrl: 'https://web.test/orders/{ORDER_ID}' },
    }),
  ],
  { pool, client, databaseUrl, executorId: 'purchase-history' },
);
await work.launch();
console.log('ready');
