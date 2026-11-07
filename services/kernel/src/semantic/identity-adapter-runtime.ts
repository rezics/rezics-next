import {
  currentCommand,
  currentCommandResources,
  IdempotencyConflictError,
  noEffect,
  registerCommandCallback,
  runCommand,
} from '../command/command.ts';
import { deadlineClient } from '../access/authenticate.ts';
import {
  assertAccountIdentitySource,
  loadAccountIdentitySource,
  readAccountIdentitySource,
  verifyAccountIdentityReversalSettlement,
} from '../access/agent-verification-identity.ts';
import { readAccountIdentityTechnicalSource } from '../access/agent-verification-identity-retention.ts';
import {
  AccessUnavailableError,
  classifyUnavailability as classifyAccessUnavailability,
} from '../access/unavailable.ts';
import { withReadTransaction } from './read.ts';
import { importedTupleRouteOf } from './adapters/imported-route.ts';
import { nativeRatingReview } from './adapters/rating-review.ts';
import { EditorialConflictError } from './candidates.ts';
import { effectiveGlobalSlotFacts } from './slots.ts';
import {
  bindIdentityAdapterPort,
  bindNativeIdentityCapabilities,
  identityAdapterPort,
  tryIdentityAdapterPort,
} from './identity-adapter-bind.ts';
import type { IdentityAdapterPort, NativeIdentityCapabilities } from './identity-adapter-port.ts';
import { createIdentityEpochStore } from './identity-adapters/index.ts';
import { createIdentityReaders } from './identity-adapters/identity-epoch-read.ts';
import { createIdentityAdmissionOperations } from './identity-epoch-admission.ts';
import { createReviewedPersonOperations } from './reviewed-person-identity.ts';
import { createIdentityRatingCommitParticipant } from './identity-rating-commit-participant.ts';

function nativeLeaves(): Omit<NativeIdentityCapabilities, 'reviewedPerson' | 'admission'> {
  return {
    read: Object.freeze({ withReadTransaction }),
    command: Object.freeze({
      currentCommand,
      currentCommandResources,
      runCommand,
      registerCommandCallback,
      noEffect,
      deadlineClient: deadlineClient as NativeIdentityCapabilities['command']['deadlineClient'],
      IdempotencyConflictError,
    }),
    routing: Object.freeze({
      importedTupleRoute: (routeKey: Uint8Array, source: string, externalId: string) =>
        importedTupleRouteOf()(routeKey, source, externalId),
    }),
    slots: Object.freeze({
      effectiveGlobalSlotFacts,
      isAccessUnavailable: (error: unknown) => error instanceof AccessUnavailableError,
      editorialConflict: () => new EditorialConflictError(),
    }),
    ratingReview: nativeRatingReview(),
    accountIdentity: Object.freeze({
      readSource: readAccountIdentitySource,
      loadSource: loadAccountIdentitySource,
      assertSource: assertAccountIdentitySource,
      readTechnicalSource: readAccountIdentityTechnicalSource,
      verifyReversalSettlement: verifyAccountIdentityReversalSettlement,
      classifyUnavailability: (error: unknown) => classifyAccessUnavailability(error) !== undefined,
    }),
  };
}

/** Real native read/command/slot/review bodies. Composition installs them once. */
export function createNativeIdentityCapabilities(): NativeIdentityCapabilities {
  const capabilities = nativeLeaves() as NativeIdentityCapabilities;
  const reviewedPerson = createReviewedPersonOperations(capabilities);
  Object.assign(capabilities, { reviewedPerson });
  const admission = createIdentityAdmissionOperations(capabilities);
  Object.assign(capabilities, {
    admission: Object.freeze({
      prepareAdmission: admission.prepareAdmission,
      bindReceipt: admission.bindReceipt,
      admitBound: admission.admitBound,
      guardReviewedPerson: admission.guardReviewedPerson,
      identityHomeAvailable: admission.identityHomeAvailable,
    }),
  });
  return Object.freeze(capabilities);
}

/** One constructed Identity application. Its store, readers, admission, reviewed Person and Rating participant
 * close over this capability set, including nested, deferred and resume/replay paths. */
export function createIdentityAdapterApplication(capabilities: NativeIdentityCapabilities): IdentityAdapterPort {
  return Object.freeze({
    store: createIdentityEpochStore(capabilities),
    read: createIdentityReaders(capabilities),
    admission: capabilities.admission,
    reviewedPerson: capabilities.reviewedPerson,
    ratingParticipant: createIdentityRatingCommitParticipant(capabilities),
  });
}

/** Bind native capabilities and the constructed identity adapter port. */
export function installIdentityAdapterRuntime(
  capabilities: NativeIdentityCapabilities = createNativeIdentityCapabilities(),
): IdentityAdapterPort {
  const port = createIdentityAdapterApplication(capabilities);
  bindNativeIdentityCapabilities(capabilities);
  bindIdentityAdapterPort(port);
  return port;
}

/** Ordinary Access/Semantic composition shares one default constructed instance. */
export function resolveIdentityAdapterRuntime(): IdentityAdapterPort {
  return tryIdentityAdapterPort() ?? installIdentityAdapterRuntime();
}

export function identityAdapterRuntime(): IdentityAdapterPort {
  return identityAdapterPort();
}

export type { IdentityAdapterPort, NativeIdentityCapabilities };
