import { bindRatingDependencies } from '../rating/dependencies.ts';
import { readAccount, readPublicIdentities } from '../access/account-data.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { resourceAuthorization } from '../access/index.ts';
import { readRealm } from '../community/realm.ts';
import { problemSchema } from '../http/problem.ts';
import { IDEMPOTENCY_HEADER, SESSION_HEADER, idempotencyKeyOf } from '../http/request.ts';
import {
  LibraryNotFoundError,
  createLibraryCommandRunner,
  libraryCommandReceiptDigestForActor,
  requireRoute,
} from '../library/command-support.ts';
import { ShelfReadUnavailableError } from '../library/shelf-reader-unavailable.ts';
import { SubjectIdentityUnavailableError, readableSubjects, resolveSubject } from '../library/subject-anchor.ts';
import { AuthenticationError, accessCheck, accessCommandAuthorization, actorOf } from '../request/access.ts';
import { readCurrentClassificationAssociation } from '../semantic/classification-association.ts';
import { publicContextEligibility, readContext } from '../semantic/context.ts';
import { currentRelationFacts, currentRelationKey } from '../semantic/current-relations.ts';
import { activeRelease, readRelease } from '../semantic/definitions.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { identityEpochStore } from '../semantic/identity-adapters/index.ts';
import { admitIdentityRatingEffect } from '../semantic/identity-rating-admission.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { withPublicStatementReader } from '../semantic/statement-disclosure.ts';
import { createSubjectCanonicalNames } from '../semantic/subject-source-key-pages.ts';
import { readSubjectSummaryObservation } from '../semantic/summaries.ts';

/** Install the exact native values; importing Rating itself never selects another domain runtime. */
export function composeRatingDependencies(): void {
  bindRatingDependencies({
    AuthenticationError,
    GrantDeniedError,
    IDEMPOTENCY_HEADER,
    LibraryNotFoundError,
    SESSION_HEADER,
    ShelfReadUnavailableError,
    SubjectIdentityUnavailableError,
    accessCheck,
    accessCommandAuthorization,
    activeRelease,
    actorOf,
    admitIdentityRatingEffect,
    createLibraryCommandRunner,
    createSubjectCanonicalNames,
    currentRelationFacts,
    currentRelationKey,
    deadlineClient,
    idempotencyKeyOf,
    identityEpochStore,
    libraryCommandReceiptDigestForActor,
    problemSchema,
    publicContextEligibility,
    readAccount,
    readContext,
    readCurrentClassificationAssociation,
    readPublicIdentities,
    readRealm,
    readRelease,
    readSubjectSummaryObservation,
    readableSubjects,
    requireRoute,
    resolveSubject,
    resourceAuthorization,
    subjectReadEligibility,
    withPublicStatementReader,
    withReadTransaction,
    within,
  });
}
