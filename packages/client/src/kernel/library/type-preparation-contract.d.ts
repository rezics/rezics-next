/** Native preparation ports; final work registration composes the bounded continuation runner. */
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { CommandTransaction } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import type { ShelfSourceStamp, ShelfTypeKeys } from './shelf-contract.ts';
export interface TypePreparationInput {
    readonly accountId: string;
    /** Original requested subject, even when sourceId is its separately observed survivor. */
    readonly subjectId: string;
    readonly requestKey: string;
    readonly sourceId: string;
    readonly source: Readonly<ShelfSourceStamp>;
    readonly ownerEpoch: bigint;
}
/** Bounded internal workflow identity. Neither a source proof nor an authorization token. */
export interface TypePreparationBinding {
    readonly accountId: string;
    readonly subjectId: string;
    readonly requestKey: string;
    readonly sourceId: string;
    readonly sourcePartition: number;
    readonly sourceEpoch: number;
    readonly sourcePosition: string;
    readonly ownerEpoch: string;
}
export declare function typePreparationBinding(input: TypePreparationInput): TypePreparationBinding;
/** Requested-source binding retained even if it redirects to the resolved source in binding. */
export interface TypePreparationOrigin {
    readonly sourceId: string;
    readonly partition: number;
    readonly epoch: number;
    readonly position: string;
    readonly survivorId: string | null;
}
/** Fixed visible create/identity version; partition position is ordering, not an item version or Access proof. */
export interface TypePreparationIdentity {
    readonly sourceId: string;
    readonly partition: number;
    readonly epoch: number;
    readonly revision: number;
    readonly transactionId: string;
    readonly redirect: string | null;
}
/** Immutable native row header. Exact input text/bytes and their equality evidence stay native. */
export interface TypePreparationEvidence {
    readonly preparationId: string;
    readonly binding: TypePreparationBinding;
    readonly origin: TypePreparationOrigin;
    readonly sourceIdentity: TypePreparationIdentity;
    readonly originIdentity: TypePreparationIdentity;
    readonly reservationId: string | null;
}
/** Persisted with the native page checkpoint/outbox, before enqueue; never contains source text. */
export interface TypePreparationIntent {
    readonly evidence: TypePreparationEvidence;
    readonly chunk: number;
    readonly offset: number;
}
/** Readiness is metadata only. Consumers reload the native evidence rather than trusting these fields. */
export interface PreparedType {
    readonly evidence: TypePreparationEvidence;
    readonly typeId: string;
}
export type TypePreparationResult = {
    readonly status: 'ready';
    readonly prepared: PreparedType;
} | {
    readonly status: 'pending';
    readonly intent: TypePreparationIntent;
} | {
    readonly status: 'refresh';
};
export type TypePreparationPageResult = {
    readonly status: 'ready';
    readonly prepared: PreparedType;
} | {
    readonly status: 'advanced';
    readonly next: TypePreparationIntent;
} | {
    readonly status: 'cancelled';
};
/** No caller-supplied account, source, type text, stamp, actor body or entry intent in metadata jobs. */
export interface TypePreparationPorts {
    /** Initial owner/subject Access, one-hop observations and ONE bounded native reservation transaction. */
    prepare(actor: Actor, input: {
        subjectId: string;
        requestKey: string;
    }): Promise<TypePreparationResult>;
    /** ONE <=100-edge native command. Its successor intent commits with progress; no user effects. */
    continue(intent: TypePreparationIntent): Promise<TypePreparationPageResult>;
    /** Fresh identity-only source/origin and current Access checks; releases source clients before returning. */
    revalidate(actor: Actor, prepared: PreparedType): Promise<'current' | 'refresh'>;
    /** Inside the ordinarily authorized entry command, check native evidence and account-share/gate again. */
    consume(tx: CommandTransaction, prepared: PreparedType): Promise<{
        readonly status: 'ready';
        readonly typeId: string;
        readonly sourceId: string;
        readonly stamp: ShelfSourceStamp;
    } | {
        readonly status: 'refresh';
    }>;
}
/** Structural source ports: initial full type and identity share RR; later reads transfer metadata only. */
export interface TypePreparationSourceObservation {
    readonly stamp: Readonly<ShelfSourceStamp>;
    readonly identity: TypePreparationIdentity | null;
    readonly type: string | null;
}
/** Concrete source adapter/keys/producer/runner are wired only at final composition. */
export type TypePreparationSourceObserved = (observation: {
    accountId: string;
    subjectId: string;
    sourceId: string;
    stamp: Readonly<ShelfSourceStamp>;
}) => Promise<void>;
export interface TypePreparationDependencies {
    readonly pool: Pool;
    readonly access: Access;
    readonly keys: ShelfTypeKeys;
    /** Bound initial observePreparationSource from the default preparation-source adapter. */
    readonly observe: (subjectId: string) => Promise<TypePreparationSourceObservation>;
    /** Bound observePreparationIdentity; no readItemTypes/full observer/full equality on this path. */
    readonly observeIdentity: (subjectId: string) => Promise<Omit<TypePreparationSourceObservation, 'type'>>;
    readonly clock?: KernelClock;
    /** Runs after both initial source checkouts have been released, before the owner command. */
    readonly typeSourceObserved?: TypePreparationSourceObserved;
}
export type TypePreparationContinuationDependencies = Pick<TypePreparationDependencies, 'pool' | 'keys' | 'observeIdentity' | 'clock'>;
export { createTypePreparationPorts, createTypePreparationContinuation } from './shelf-type-keys.ts';
