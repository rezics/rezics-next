import { createStripePort } from './stripe.ts';
import { readCommerceWorkerConfig } from './config.ts';
import type { WorkModule } from '../work/registry.ts';

export const commerceWorkModule: WorkModule = {
  name: 'commerce',
  async register(context) {
    const config = readCommerceWorkerConfig(context.env);
    const { createCommerceWork } = await import('./work.ts');
    await createCommerceWork({
      stripe: createStripePort({ ...config.stripe, clock: () => new Date() }),
      checkout: { successUrl: config.successUrl, cancelUrl: config.cancelUrl },
    }).register(context);
  },
};
