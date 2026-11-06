/** Source observation comparison and private-working versus activated-public classification. */

import type { CollectionSourceAuthority, CollectionSourceObservation } from '../contract/index.ts';

export function sameSource(left: CollectionSourceObservation, right: CollectionSourceObservation): boolean {
  return (
    left.collectionId === right.collectionId &&
    left.route === right.route &&
    left.incarnation === right.incarnation &&
    left.revision === right.revision &&
    left.stamp.epoch === right.stamp.epoch &&
    JSON.stringify(left.authority) === JSON.stringify(right.authority) &&
    JSON.stringify(left.basis) === JSON.stringify(right.basis)
  );
}

export function isPrivateWorkingAuthority(authority: CollectionSourceAuthority): boolean {
  return authority.kind === 'curated' || authority.kind === 'private_builtin';
}

export function isActivatedPublicAuthority(authority: CollectionSourceAuthority): boolean {
  return authority.kind === 'activated_output';
}

export function classifySourceOutput(
  observation: CollectionSourceObservation,
): 'private_working' | 'activated_public' | 'frozen' {
  if (observation.authority.kind === 'activated_output') return 'activated_public';
  if (observation.authority.kind === 'frozen_output') return 'frozen';
  return 'private_working';
}
