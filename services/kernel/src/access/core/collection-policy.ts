/** Pure Collection list residual interpretation and owner/public fact selection.
 * Native catalogue compilation, specializePolicy and SQL stay in Access adapters.
 */

import {
  COLLECTION_PUBLIC_FLOOR_OPERAND,
  COLLECTION_READ_ACTION,
  COLLECTION_RESOURCE_TYPE,
  type CollectionListPolicyFacts,
  type CollectionListPolicyOutcome,
  type CollectionListPolicyRequest,
  type CollectionListResourceOperand,
} from '../contract/index.ts';
import type { AccessWorkDimensions } from '../contract/bounds.ts';
import { sumOriginalControl } from './original-work.ts';

const OWNER_ACTOR = Object.freeze({
  actionGrant: false,
  resourceRoleGrant: true,
  ownAccount: false,
  authenticatedBenefit: false,
});

const PUBLIC_ACTOR = Object.freeze({
  actionGrant: false,
  resourceRoleGrant: false,
  ownAccount: false,
  authenticatedBenefit: false,
});

const OWNER_FACTS: CollectionListPolicyFacts = Object.freeze({
  standing: true,
  assignment: true,
  deadlineLive: true,
  scope: true,
  localDenial: false,
  publicFloor: false,
  actor: OWNER_ACTOR,
});

const PUBLIC_FACTS: CollectionListPolicyFacts = Object.freeze({
  standing: true,
  assignment: true,
  deadlineLive: true,
  scope: false,
  localDenial: false,
  actor: PUBLIC_ACTOR,
});

export function collectionListPolicyRequest(fullView: boolean): CollectionListPolicyRequest {
  return Object.freeze({
    action: COLLECTION_READ_ACTION,
    resourceType: COLLECTION_RESOURCE_TYPE,
    mode: 'ordinary',
    authenticatedBenefit: false,
    anonymous: !fullView,
    hasPrincipal: false,
  });
}

export function collectionListPolicyFacts(fullView: boolean): CollectionListPolicyFacts {
  return fullView ? OWNER_FACTS : PUBLIC_FACTS;
}

const OWNER_RESIDUALS: readonly CollectionListResourceOperand[] = [];
const PUBLIC_RESIDUALS: readonly CollectionListResourceOperand[] = [COLLECTION_PUBLIC_FLOOR_OPERAND];

export function collectionListRequiredResiduals(fullView: boolean): readonly CollectionListResourceOperand[] {
  return fullView ? OWNER_RESIDUALS : PUBLIC_RESIDUALS;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownValue(value: Record<string, unknown>, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError('Invalid residual data');
  return descriptor.value;
}

/** Lower only the two residual shapes admitted by the current indexed list profile. */
export function interpretCollectionListResidual(residual: unknown): CollectionListPolicyOutcome {
  try {
    if (!plainObject(residual) || Reflect.ownKeys(residual).length !== 2) return { status: 'unavailable' };
    if (ownValue(residual, 'format') !== 'rezics-access-residual/1') return { status: 'unavailable' };
    const root = ownValue(residual, 'root');
    if (!plainObject(root)) return { status: 'unavailable' };
    const operation = ownValue(root, 'op');
    if (operation === 'constant' && Reflect.ownKeys(root).length === 2) {
      const value = ownValue(root, 'value');
      if (typeof value !== 'boolean') return { status: 'unavailable' };
      return value ? Object.freeze({ status: 'ready', source: 'curator' }) : { status: 'unavailable' };
    }
    if (operation === 'operand' && Reflect.ownKeys(root).length === 2 && ownValue(root, 'name') === 'public.floor')
      return Object.freeze({ status: 'ready', source: 'public' });
    return { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

export function admitCollectionListOutcome(
  outcome: CollectionListPolicyOutcome,
  fullView: boolean,
): CollectionListPolicyOutcome {
  if (outcome.status !== 'ready') return { status: 'unavailable' };
  if (fullView ? outcome.source !== 'curator' : outcome.source !== 'public') return { status: 'unavailable' };
  return outcome;
}

export function sumCollectionAuthorizationWork(parts: readonly AccessWorkDimensions[]): AccessWorkDimensions {
  return sumOriginalControl(...parts);
}
