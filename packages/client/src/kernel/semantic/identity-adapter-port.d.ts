import type { Pool, PoolClient } from 'pg';
import type { Release } from '@rezics/definitions';
import type { AccountIdentityReversalSettlement, AccountIdentitySource } from '../access/agent-verification-identity.ts';
import type { CommandAuthorization, CommandBasis, CommandResult, CommandTransaction, CurrentCommand } from '../command/command.ts';
import type { RatingReviewPort } from './contract/domain-ports.ts';
import type { IdentityAdmissionInput, IdentityEpochStore, IdentityIntent, IdentityJobRef, IdentityReceipt, IdentityReceiptBinding, ReviewedPersonEndpoint, ReviewedPersonExpectation, ReviewedPersonSource } from './identity-adapters/identity-epoch-contract.ts';
import type { IdentitySourceConsumerReference } from './identity-source-consumer-custody.ts';
import type { BasisRead, HomeIdentity, IdentityRepairEvidence } from './identity-adapters/identity-epoch-read.ts';
import type { IdentityMapping, IdentityRatingNativeEvidence, IdentityRatingReviewResult } from './identity-core/index.ts';
import type { IdentityRatingCommitParticipant } from './identity-rating-commit-participant.ts';
/** One queryable native connection held by the caller. */
export type NativeIdentityQueryable = Readonly<{
    query: (text: string, values?: unknown[]) => Promise<{
        rows: Record<string, unknown>[];
        rowCount?: number | null;
    }>;
}>;
/** Narrow released-home read used by mapping and rating-review readers. */
export type NativeIdentityRead = Readonly<{
    withReadTransaction<T>(pool: Pool, read: (client: PoolClient) => Promise<T>, deadline?: number): Promise<T>;
}>;
/** Narrow command executor used by binding, admission, reviewed Person and Rating participants. */
export type NativeIdentityCommandOptions = Readonly<{
    partition: number;
    deadline?: number;
    basis?: CommandBasis;
    authorization?: CommandAuthorization;
    clock?: () => Date;
}>;
export type NativeIdentityCommand = Readonly<{
    currentCommand(tx: CommandTransaction): CurrentCommand;
    currentCommandResources(tx: CommandTransaction): Readonly<{
        deadline: number;
    }>;
    runCommand<T>(pool: Pool, options: NativeIdentityCommandOptions, body: (tx: CommandTransaction) => Promise<CommandResult<T>>): Promise<Readonly<{
        value: T;
    }>>;
    registerCommandCallback(tx: CommandTransaction, callback: (transactionId: string) => void | Promise<void>): void;
    noEffect<T>(value: T): CommandResult<T>;
    deadlineClient(tx: CommandTransaction, deadline: number): CommandTransaction;
    IdempotencyConflictError: new (partition: number) => Error;
}>;
/** Imported-tuple home selection without loading Content cover media. */
export type NativeIdentityRouting = Readonly<{
    importedTupleRoute(routeKey: Uint8Array, source: string, externalId: string): number;
}>;
export type NativeReviewedPersonSlotFacts = Readonly<{
    facts: readonly Readonly<{
        body: unknown;
    }>[];
    basis: unknown;
}>;
/** Slot and editorial conflict surfaces used by reviewed Person observation. */
export type NativeReviewedPersonSlots = Readonly<{
    effectiveGlobalSlotFacts(tx: CommandTransaction, subject: string, property: string, slot?: string, lockSelected?: boolean): Promise<NativeReviewedPersonSlotFacts>;
    isAccessUnavailable(error: unknown): boolean;
    editorialConflict(): Error;
}>;
export type NativeReviewedPersonOperations = Readonly<{
    observe(tx: CommandTransaction, subject: string, source: ReviewedPersonSource, routeKey: Uint8Array, release: Release, lockSelected?: boolean): Promise<ReviewedPersonEndpoint | null>;
    guard(tx: CommandTransaction, expected: ReviewedPersonExpectation, routeKey: Uint8Array, release: Release): Promise<void>;
}>;
export type NativeIdentityAdmission = Readonly<{
    prepareAdmission: IdentityEpochStore['prepareAdmission'];
    bindReceipt: IdentityEpochStore['bindReceipt'];
    admitBound(tx: CommandTransaction, input: IdentityAdmissionInput & Readonly<{
        binding: IdentityReceiptBinding;
    }>, immediate?: boolean): Promise<CommandResult<IdentityJobRef>>;
    guardReviewedPerson(tx: CommandTransaction, input: IdentityAdmissionInput): Promise<void>;
    identityHomeAvailable(partition: number, after?: string): Readonly<{
        type: string;
        data: Readonly<{
            partition: number;
            after: string;
        }>;
    }>;
}>;
type AccountAgentReceipt = Extract<IdentityReceipt, {
    kind: 'account-agent.verify' | 'account-agent.unverify';
}>;
/** Access Agent source, technical receiver and reversal ports bound at composition. */
export type NativeAccountIdentity = Readonly<{
    readSource(tx: CommandTransaction, receipt: AccountAgentReceipt, intent?: IdentityIntent, undoOnly?: boolean): Promise<AccountIdentitySource>;
    loadSource(pool: Pool, receipt: AccountAgentReceipt): Promise<AccountIdentitySource>;
    assertSource(source: AccountIdentitySource, receipt: AccountAgentReceipt, intent?: IdentityIntent): void;
    readTechnicalSource(tx: CommandTransaction, receipt: AccountAgentReceipt): Promise<AccountIdentitySource | null>;
    verifyReversalSettlement(tx: CommandTransaction, reference: IdentitySourceConsumerReference, reversal: AccountIdentityReversalSettlement): Promise<boolean>;
    classifyUnavailability(error: unknown): boolean;
}>;
/** Bound native capabilities. Vocabulary stays here; composition installs the bodies. */
export type NativeIdentityCapabilities = Readonly<{
    read: NativeIdentityRead;
    command: NativeIdentityCommand;
    routing: NativeIdentityRouting;
    slots: NativeReviewedPersonSlots;
    ratingReview: RatingReviewPort;
    reviewedPerson: NativeReviewedPersonOperations;
    admission: NativeIdentityAdmission;
    accountIdentity: NativeAccountIdentity;
}>;
export type IdentityNativeReaders = Readonly<{
    readIdentityMappings(pool: Pool, originals: readonly string[]): Promise<IdentityMapping[]>;
    readIdentityRatingReview(pool: Pool, input: Readonly<{
        requestedOriginalId: string;
        canonicalTerminalId: string;
        deadline: number;
    }>): Promise<IdentityRatingReviewResult>;
    readIdentityRatingEvidenceInTransaction(client: NativeIdentityQueryable, input: Readonly<{
        sourceIdentities: readonly string[];
        commandHome: number;
    }>): Promise<Readonly<{
        state: 'ready';
        evidence: IdentityRatingNativeEvidence;
    }> | Readonly<{
        state: 'foreign-control';
    }>>;
    readIdentityRepairEvidenceInTransaction(client: NativeIdentityQueryable, input: Readonly<{
        originals: readonly string[];
        commandHome: number;
    }>): Promise<IdentityRepairEvidence>;
    readIdentityBasis(pool: Pool, options: {
        deadline: number;
    }): Promise<BasisRead>;
    readIdentityHome(client: PoolClient, partition: number): Promise<HomeIdentity>;
}>;
/** Consumer-owned identity adapter port installed at the composition root. */
export type IdentityAdapterPort = Readonly<{
    store: IdentityEpochStore;
    read: IdentityNativeReaders;
    admission: NativeIdentityAdmission;
    reviewedPerson: NativeReviewedPersonOperations;
    ratingParticipant: IdentityRatingCommitParticipant;
}>;
export type { IdentityReceipt, IdentityReceiptBinding };
