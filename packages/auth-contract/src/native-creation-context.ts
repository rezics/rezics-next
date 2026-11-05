import type { AccountOperation } from './index.ts';

/** Private attribution from an existing native approval, never authorization,
 * an Actor, an operation result, or an erasure/consumer-completion witness. */
export type NativeCreationContext = Readonly<{
  actorAccountId: string;
  actingHumanId: string | null;
  operatorAccountId: string | null;
  principalAccountId: string | null;
  sourceClientId: string;
  approvalReference: string;
  /** Existing native stable command prefix; native steps append their fixed phase. */
  commandKey: string;
  operationKey: string;
  operationDigest: string;
  /** Only the existing native permission target, not a future account or client owner. */
  operation: Readonly<{
    kind: Exclude<AccountOperation['kind'], 'consent'>;
    action:
      | 'account:suspend'
      | 'client:manage'
      | 'account:manage'
      | 'organization:create'
      | 'account:update'
      | 'account:delete'
      | 'organization:membership';
    targetResourceId: string;
    targetClientId: string | null;
  }>;
}>;

/** The complete existing command is compared with its immutable approval. It is
 * input only: the projection never copies its business payload or credentials. */
export type NativeCreationContextRequest = Readonly<{
  approvalReference: string | null;
  operationKey: string;
  operation: AccountOperation & { operationKey?: string };
}>;

export type NativeCreationContextResult =
  | Readonly<{ kind: 'available'; context: NativeCreationContext }>
  | Readonly<{
      kind: 'unavailable';
      reason: 'historical-provenance' | 'opening-provenance';
    }>;

export type ReadNativeCreationContext = (input: NativeCreationContextRequest) => Promise<NativeCreationContextResult>;
