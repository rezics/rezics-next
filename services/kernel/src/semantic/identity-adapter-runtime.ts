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
} from './identity-adapter-bind.ts';
import type { IdentityAdapterPort, NativeIdentityCapabilities } from './identity-adapter-port.ts';
import { identityEpochStore } from './identity-adapters/index.ts';
import {
  readIdentityBasis,
  readIdentityHome,
  readIdentityMappings,
  readIdentityRatingEvidenceInTransaction,
  readIdentityRatingReview,
  readIdentityRepairEvidenceInTransaction,
} from './identity-adapters/identity-epoch-read.ts';
import {
  admitBoundIdentityEpoch,
  bindIdentityEpochReceipt,
  guardIdentityAdmissionReviewedPerson,
  identityHomeAvailable,
  prepareIdentityEpochAdmission,
} from './identity-epoch-admission.ts';
import { guardReviewedPersonIdentity, observeReviewedPersonIdentity } from './reviewed-person-identity.ts';
import { createIdentityRatingCommitParticipant } from './identity-rating-commit-participant.ts';

/** Real native read/command/slot/review bodies. Composition installs them once. */
export function createNativeIdentityCapabilities(): NativeIdentityCapabilities {
  return Object.freeze({
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
    reviewedPerson: Object.freeze({
      observe: observeReviewedPersonIdentity,
      guard: guardReviewedPersonIdentity,
    }),
    admission: Object.freeze({
      prepareAdmission: prepareIdentityEpochAdmission,
      bindReceipt: bindIdentityEpochReceipt,
      admitBound: admitBoundIdentityEpoch,
      guardReviewedPerson: guardIdentityAdmissionReviewedPerson,
      identityHomeAvailable,
    }),
    accountIdentity: Object.freeze({
      readSource: readAccountIdentitySource,
      loadSource: loadAccountIdentitySource,
      assertSource: assertAccountIdentitySource,
      readTechnicalSource: readAccountIdentityTechnicalSource,
      verifyReversalSettlement: verifyAccountIdentityReversalSettlement,
      classifyUnavailability: (error: unknown) => classifyAccessUnavailability(error) !== undefined,
    }),
  });
}

function livePort(capabilities: NativeIdentityCapabilities): IdentityAdapterPort {
  bindNativeIdentityCapabilities(capabilities);
  return Object.freeze({
    store: identityEpochStore(),
    read: Object.freeze({
      readIdentityMappings,
      readIdentityRatingReview,
      readIdentityRatingEvidenceInTransaction,
      readIdentityRepairEvidenceInTransaction,
      readIdentityBasis,
      readIdentityHome,
    }),
    reviewedPerson: capabilities.reviewedPerson,
    ratingParticipant: createIdentityRatingCommitParticipant(),
  });
}

/** Bind native capabilities and the constructed identity adapter port. */
export function installIdentityAdapterRuntime(
  capabilities: NativeIdentityCapabilities = createNativeIdentityCapabilities(),
): IdentityAdapterPort {
  const port = livePort(capabilities);
  bindIdentityAdapterPort(port);
  return port;
}

export function identityAdapterRuntime(): IdentityAdapterPort {
  return identityAdapterPort();
}

export type { IdentityAdapterPort, NativeIdentityCapabilities };
