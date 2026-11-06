/** Publication admission predicates. Episode data arrives as values; Access and Semantic stay behind ports. */

import type { PublicationAdmissionResult } from '../contract/index.ts';
import type { CollectionSourceObservation } from '../contract/index.ts';
import { classifySourceOutput, isActivatedPublicAuthority, isPrivateWorkingAuthority } from './source-basis.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type PublicationLocator = NonNullable<PublicationAdmissionResult['locator']>;

export function exactPublicationLocator(value: unknown): value is PublicationLocator {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const locator = value as PublicationLocator;
  return (
    typeof locator.route === 'number' &&
    Number.isSafeInteger(locator.route) &&
    typeof locator.ownerAccountId === 'string' &&
    typeof locator.collectionId === 'string' &&
    typeof locator.publicationId === 'string' &&
    uuid.test(locator.ownerAccountId) &&
    uuid.test(locator.collectionId) &&
    uuid.test(locator.publicationId)
  );
}

export function admitPublication(input: {
  locator: PublicationLocator | null;
  privateWorking: boolean;
  observation: CollectionSourceObservation | null;
  episodePresent: boolean;
}): PublicationAdmissionResult {
  if (!input.locator || !exactPublicationLocator(input.locator) || !input.episodePresent || !input.observation) {
    return {
      admitted: false,
      phase: 'unavailable',
      privateWorking: input.privateWorking,
      activatedPublic: false,
      locator: input.locator && exactPublicationLocator(input.locator) ? input.locator : null,
    };
  }
  const output = classifySourceOutput(input.observation);
  const activatedPublic = output === 'activated_public' && isActivatedPublicAuthority(input.observation.authority);
  const privateWorking = input.privateWorking && isPrivateWorkingAuthority(input.observation.authority);
  if (input.privateWorking && activatedPublic) {
    return {
      admitted: false,
      phase: 'unavailable',
      privateWorking: true,
      activatedPublic: true,
      locator: input.locator,
    };
  }
  return {
    admitted: privateWorking || activatedPublic,
    phase: activatedPublic ? 'awaiting_activation' : privateWorking ? 'staging' : 'unavailable',
    privateWorking,
    activatedPublic,
    locator: input.locator,
  };
}
