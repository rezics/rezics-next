import { createStripePort } from './stripe.ts';
import { readCommerceWorkerConfig, readCommerceProviderConfig } from './config.ts';
import type { WorkModule } from '../work/registry.ts';

export const commerceWorkModule: WorkModule = {
  name: 'commerce',
  async register(context) {
    const config = readCommerceWorkerConfig(context.env);
    if (config === null) return;
    const { createCommerceWork } = await import('./work.ts');
    await createCommerceWork({
      stripe: createStripePort({ ...config.stripe, clock: context.clock }),
      provider: readCommerceProviderConfig(context.env),
      checkout: { successUrl: config.successUrl, cancelUrl: config.cancelUrl },
    }).register(context);
  },
};
