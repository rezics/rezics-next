import { registerSubjectOfferWork } from './subject-offer-work.ts';
import { registerCreatorSales } from './creator-sales-work.ts';
import { registerCommerceErasure } from './erasure-participant.ts';
import { createStripePort } from './stripe.ts';
import { readCommerceWorkerConfig, readCommerceProviderConfig } from './config.ts';
import type { WorkModule } from '../work/registry.ts';

export const commerceWorkModule: WorkModule = {
  name: 'commerce',
  async register(context) {
    const config = readCommerceWorkerConfig(context.env);
    if (config === null) {
      registerCommerceErasure(context);
      registerSubjectOfferWork(context);
      await registerCreatorSales(context);
      return;
    }
    const { createCommerceWork } = await import('./work.ts');
    await createCommerceWork({
      stripe: createStripePort({ ...config.stripe, clock: context.clock }),
      provider: readCommerceProviderConfig(context.env),
      checkout: { successUrl: config.successUrl, cancelUrl: config.cancelUrl },
    }).register(context);
  },
};
