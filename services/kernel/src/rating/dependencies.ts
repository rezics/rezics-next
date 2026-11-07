/** Rating owns these foreign capabilities; Kernel composition supplies the native implementations. */
import type * as Accounts from '../access/account-data.ts';
import type * as Authentication from '../access/authenticate.ts';
import type * as Grants from '../access/grant-commands.ts';
import type * as Resources from '../access/index.ts';
import type * as Realms from '../community/realm.ts';
import type * as Problems from '../http/problem.ts';
import type * as Requests from '../http/request.ts';
import type * as LibraryCommands from '../library/command-support.ts';
import type * as ShelfReading from '../library/shelf-reader-unavailable.ts';
import type * as SubjectAnchors from '../library/subject-anchor.ts';
import type * as RequestAccess from '../request/access.ts';
import type * as Classifications from '../semantic/classification-association.ts';
import type * as Contexts from '../semantic/context.ts';
import type * as Relations from '../semantic/current-relations.ts';
import type * as Definitions from '../semantic/definitions.ts';
import type * as Eligibility from '../semantic/eligibility.ts';
import type * as IdentityEpochs from '../semantic/identity-adapters/index.ts';
import type * as IdentityAdmission from '../semantic/identity-rating-admission.ts';
import type * as Reading from '../semantic/read.ts';
import type * as Statements from '../semantic/statement-disclosure.ts';
import type * as CanonicalNames from '../semantic/subject-source-key-pages.ts';
import type * as Summaries from '../semantic/summaries.ts';

export interface RatingDependencies {
  readonly AuthenticationError: typeof RequestAccess.AuthenticationError;
  readonly GrantDeniedError: typeof Grants.GrantDeniedError;
  readonly IDEMPOTENCY_HEADER: typeof Requests.IDEMPOTENCY_HEADER;
  readonly LibraryNotFoundError: typeof LibraryCommands.LibraryNotFoundError;
  readonly SESSION_HEADER: typeof Requests.SESSION_HEADER;
  readonly ShelfReadUnavailableError: typeof ShelfReading.ShelfReadUnavailableError;
  readonly SubjectIdentityUnavailableError: typeof SubjectAnchors.SubjectIdentityUnavailableError;
  readonly accessCheck: typeof RequestAccess.accessCheck;
  readonly accessCommandAuthorization: typeof RequestAccess.accessCommandAuthorization;
  readonly activeRelease: typeof Definitions.activeRelease;
  readonly actorOf: typeof RequestAccess.actorOf;
  readonly admitIdentityRatingEffect: typeof IdentityAdmission.admitIdentityRatingEffect;
  readonly createLibraryCommandRunner: typeof LibraryCommands.createLibraryCommandRunner;
  readonly createSubjectCanonicalNames: typeof CanonicalNames.createSubjectCanonicalNames;
  readonly currentRelationFacts: typeof Relations.currentRelationFacts;
  readonly currentRelationKey: typeof Relations.currentRelationKey;
  readonly deadlineClient: typeof Authentication.deadlineClient;
  readonly idempotencyKeyOf: typeof Requests.idempotencyKeyOf;
  readonly identityEpochStore: typeof IdentityEpochs.identityEpochStore;
  readonly libraryCommandReceiptDigestForActor: typeof LibraryCommands.libraryCommandReceiptDigestForActor;
  readonly problemSchema: typeof Problems.problemSchema;
  readonly publicContextEligibility: typeof Contexts.publicContextEligibility;
  readonly readAccount: typeof Accounts.readAccount;
  readonly readContext: typeof Contexts.readContext;
  readonly readCurrentClassificationAssociation: typeof Classifications.readCurrentClassificationAssociation;
  readonly readPublicIdentities: typeof Accounts.readPublicIdentities;
  readonly readRealm: typeof Realms.readRealm;
  readonly readRelease: typeof Definitions.readRelease;
  readonly readSubjectSummaryObservation: typeof Summaries.readSubjectSummaryObservation;
  readonly readableSubjects: typeof SubjectAnchors.readableSubjects;
  readonly requireRoute: typeof LibraryCommands.requireRoute;
  readonly resolveSubject: typeof SubjectAnchors.resolveSubject;
  readonly resourceAuthorization: typeof Resources.resourceAuthorization;
  readonly subjectReadEligibility: typeof Eligibility.subjectReadEligibility;
  readonly withPublicStatementReader: typeof Statements.withPublicStatementReader;
  readonly withReadTransaction: typeof Reading.withReadTransaction;
  readonly within: typeof Authentication.within;
}

export type Access = RequestAccess.Access;
export type Account = Accounts.Account;
export type Actor = RequestAccess.Actor;
export type CurrentClassificationAssociation = Classifications.CurrentClassificationAssociation;
export type PublicIdentity = Accounts.PublicIdentity;
export type SubjectCanonicalNameKey = CanonicalNames.SubjectCanonicalNameKey;
export type SubjectCanonicalPopulation = CanonicalNames.SubjectCanonicalPopulation;
export type SubjectSummary = Summaries.SubjectSummary;

// Live bindings retain function overloads, generic signatures, constructor and error identity.
export let AuthenticationError: RatingDependencies['AuthenticationError'];
export let GrantDeniedError: RatingDependencies['GrantDeniedError'];
export let IDEMPOTENCY_HEADER: RatingDependencies['IDEMPOTENCY_HEADER'];
export let LibraryNotFoundError: RatingDependencies['LibraryNotFoundError'];
export let SESSION_HEADER: RatingDependencies['SESSION_HEADER'];
export let ShelfReadUnavailableError: RatingDependencies['ShelfReadUnavailableError'];
export let SubjectIdentityUnavailableError: RatingDependencies['SubjectIdentityUnavailableError'];
export let accessCheck: RatingDependencies['accessCheck'];
export let accessCommandAuthorization: RatingDependencies['accessCommandAuthorization'];
export let activeRelease: RatingDependencies['activeRelease'];
export let actorOf: RatingDependencies['actorOf'];
export let admitIdentityRatingEffect: RatingDependencies['admitIdentityRatingEffect'];
export let createLibraryCommandRunner: RatingDependencies['createLibraryCommandRunner'];
export let createSubjectCanonicalNames: RatingDependencies['createSubjectCanonicalNames'];
export let currentRelationFacts: RatingDependencies['currentRelationFacts'];
export let currentRelationKey: RatingDependencies['currentRelationKey'];
export let deadlineClient: RatingDependencies['deadlineClient'];
export let idempotencyKeyOf: RatingDependencies['idempotencyKeyOf'];
export let identityEpochStore: RatingDependencies['identityEpochStore'];
export let libraryCommandReceiptDigestForActor: RatingDependencies['libraryCommandReceiptDigestForActor'];
export let problemSchema: RatingDependencies['problemSchema'];
export let publicContextEligibility: RatingDependencies['publicContextEligibility'];
export let readAccount: RatingDependencies['readAccount'];
export let readContext: RatingDependencies['readContext'];
export let readCurrentClassificationAssociation: RatingDependencies['readCurrentClassificationAssociation'];
export let readPublicIdentities: RatingDependencies['readPublicIdentities'];
export let readRealm: RatingDependencies['readRealm'];
export let readRelease: RatingDependencies['readRelease'];
export let readSubjectSummaryObservation: RatingDependencies['readSubjectSummaryObservation'];
export let readableSubjects: RatingDependencies['readableSubjects'];
export let requireRoute: RatingDependencies['requireRoute'];
export let resolveSubject: RatingDependencies['resolveSubject'];
export let resourceAuthorization: RatingDependencies['resourceAuthorization'];
export let subjectReadEligibility: RatingDependencies['subjectReadEligibility'];
export let withPublicStatementReader: RatingDependencies['withPublicStatementReader'];
export let withReadTransaction: RatingDependencies['withReadTransaction'];
export let within: RatingDependencies['within'];

/** Called by the ordinary process composition before constructing Rating handlers or work. */
export function bindRatingDependencies(dependencies: RatingDependencies): void {
  ({
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
  } = dependencies);
}
