import { createIdentityRatingRepairProducer } from '../semantic/identity-rating-repair-producer.ts';

let installed: ReturnType<typeof createIdentityRatingRepairProducer> | undefined;

/** Bind the native Identity mapping/obligation producer used by Rating identity repair. */
export function installIdentityRatingRepairProducer(): void {
  installed = createIdentityRatingRepairProducer();
}

export function identityRatingRepairProducer(): ReturnType<typeof createIdentityRatingRepairProducer> {
  if (!installed) throw new TypeError('Identity rating repair producer is not installed');
  return installed;
}
