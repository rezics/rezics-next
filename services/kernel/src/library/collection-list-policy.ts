import {
  specializePolicy,
  type PolicyCatalogue,
  type PolicyFacts,
} from '@rezics/access';
import { lowerCollectionListResidual, type CollectionListFilter } from '../access/policy-filter.ts';

const COLLECTION_READ_REQUEST = Object.freeze({
  action: 'collection:read',
  resourceType: 'library.collection',
  mode: 'ordinary' as const,
  authenticatedBenefit: false,
});

const OWNER_FACTS: PolicyFacts = Object.freeze({
  standing: true,
  assignment: true,
  deadlineLive: true,
  scope: true,
  localDenial: false,
  publicFloor: false,
  actor: Object.freeze({
    actionGrant: false,
    resourceRoleGrant: true,
    ownAccount: false,
    authenticatedBenefit: false,
  }),
});

const PUBLIC_FACTS = Object.freeze({
  standing: true,
  assignment: true,
  deadlineLive: true,
  scope: false,
  localDenial: false,
  actor: Object.freeze({
    actionGrant: false,
    resourceRoleGrant: false,
    ownAccount: false,
    authenticatedBenefit: false,
  }),
}) as unknown as PolicyFacts;

/** Bind the native full-view qualification or retain the indexed public floor as row data. */
export function specializeCollectionListPolicy(
  catalogue: PolicyCatalogue | undefined,
  fullView: boolean,
): CollectionListFilter {
  if (!catalogue) return { status: 'unavailable' };
  const request = { ...COLLECTION_READ_REQUEST, anonymous: !fullView, hasPrincipal: false };
  const specialization = specializePolicy(
    catalogue,
    request,
    fullView ? OWNER_FACTS : PUBLIC_FACTS,
    fullView ? [] : ['public.floor'],
  );
  if (specialization.status !== 'ready') return { status: 'unavailable' };
  const filter = lowerCollectionListResidual(specialization.residual);
  if (filter.status !== 'ready' || (fullView ? filter.source !== 'curator' : filter.source !== 'public'))
    return { status: 'unavailable' };
  return filter;
}
