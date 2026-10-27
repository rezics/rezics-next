/** Proposed native ports only. The binding helper is implemented; all effectful ports throw. */
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { CommandTransaction } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import type { ShelfSourceStamp, ShelfTypeKeys } from './shelf-contract.ts';
import type { observeShelfType } from './shelf-type-source.ts';

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

export function typePreparationBinding(input: TypePreparationInput): TypePreparationBinding {
  if (input.source.position < 0n || input.ownerEpoch < 0n)
    throw new RangeError('Preparation positions and owner epochs must be nonnegative');
  return Object.freeze({
    accountId: input.accountId,
    subjectId: input.subjectId,
    requestKey: input.requestKey,
    sourceId: input.sourceId,
    sourcePartition: input.source.partition,
    sourceEpoch: input.source.epoch,
    sourcePosition: input.source.position.toString(10),
    ownerEpoch: input.ownerEpoch.toString(10),
  });
}

/** Requested-source binding retained even if it redirects to the resolved source in binding. */
export interface TypePreparationOrigin {
  readonly sourceId: string;
  readonly partition: number;
  readonly epoch: number;
  readonly position: string;
  readonly survivorId: string | null;
}

/** Immutable native row header. Exact input text/bytes and their equality evidence stay native. */
export interface TypePreparationEvidence {
  readonly preparationId: string;
  readonly binding: TypePreparationBinding;
  readonly origin: TypePreparationOrigin;
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

export type TypePreparationResult =
  | { readonly status: 'ready'; readonly prepared: PreparedType }
  | { readonly status: 'pending'; readonly intent: TypePreparationIntent }
  | { readonly status: 'refresh' };

export type TypePreparationPageResult =
  | { readonly status: 'ready'; readonly prepared: PreparedType }
  | { readonly status: 'advanced'; readonly next: TypePreparationIntent }
  | { readonly status: 'cancelled' };

/** No caller-supplied account, source, type text, stamp, actor body or entry intent in metadata jobs. */
export interface TypePreparationPorts {
  /** Initial owner/subject Access, one-hop observations and ONE bounded native reservation transaction. */
  prepare(actor: Actor, input: { subjectId: string; requestKey: string }): Promise<TypePreparationResult>;
  /** ONE <=100-edge native command. Its successor intent commits with progress; no user effects. */
  continue(intent: TypePreparationIntent): Promise<TypePreparationPageResult>;
  /** Fresh source/redirect and current Access checks; releases every source connection before returning. */
  revalidate(actor: Actor, prepared: PreparedType): Promise<'current' | 'refresh'>;
  /** Inside the ordinarily authorized entry command, check native evidence and account-share/gate again. */
  consume(
    tx: CommandTransaction,
    prepared: PreparedType,
  ): Promise<
    | { readonly status: 'ready'; readonly typeId: string; readonly sourceId: string; readonly stamp: ShelfSourceStamp }
    | { readonly status: 'refresh' }
  >;
}

/** Existing committed types; concrete composed keys/producer/runner are wired only at final composition. */
export interface TypePreparationDependencies {
  readonly pool: Pool;
  readonly access: Access;
  readonly keys: ShelfTypeKeys;
  readonly observe: typeof observeShelfType;
  readonly clock?: KernelClock;
}

export function createTypePreparationPorts(_dependencies: TypePreparationDependencies): TypePreparationPorts {
  function missing(operation: string): never {
    throw new Error(`Library type preparation is not implemented: ${operation}`);
  }
  return {
    prepare: async () => missing('prepare'),
    continue: async () => missing('continue'),
    revalidate: async () => missing('revalidate'),
    consume: async () => missing('consume'),
  };
}
