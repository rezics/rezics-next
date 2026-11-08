import type { Pool } from 'pg';
import { type CommandTransaction, type AuthoritativeTime } from '../command/command.ts';
import type { NativePublicOutputApplication, PublicOutputCommandContext, LockPublicOutputDisposition } from '../library/contract/native-public-output.ts';
type NativePublicOutputPort = NativePublicOutputApplication<CommandTransaction, Pool, AuthoritativeTime>;
import type { PublicFilterSourceFactory } from './public-filter-source-contract.ts';
import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
import type { IdentityScopeKey } from './identity-scope-types.ts';
import type * as T from './identity-public-output-types.ts';
/** Every call owns one finite frame. Command retries are surrendered; continuation is persisted. */
export declare function createPublicIdentityOutputCapture(config: Parameters<PublicFilterSourceFactory>[0], nativeOutput: NativePublicOutputPort): {
    accept: (request: T.PublicIdentityOutputAcceptance, options: T.PublicIdentityOutputWork) => Promise<T.PublicIdentityOutputResult<{
        status: 'accepted';
        capture: Readonly<{
            kind: 'public-output';
            partition: number;
            captureId: string;
            bindingDigest: string;
        }>;
    }>>;
    capturePage: (l: T.PublicIdentityOutputCapture, continuation: string, inputLimit: number, options: T.PublicIdentityOutputWork) => Promise<T.PublicIdentityOutputResult<{
        status: "exhausted" | "progress";
        capture: Readonly<{
            kind: 'public-output';
            partition: number;
            captureId: string;
            bindingDigest: string;
        }>;
        continuation: string;
    }>>;
    seal: (l: T.PublicIdentityOutputCapture, options: T.PublicIdentityOutputWork) => Promise<T.PublicIdentityOutputResult<{
        status: 'sealed';
        seal: {
            capture: Readonly<{
                kind: 'public-output';
                partition: number;
                captureId: string;
                bindingDigest: string;
            }>;
            manifestDigest: string;
            native: Readonly<{
                partition: number;
                epoch: number;
                position: bigint;
                transactionId: string;
            }>;
        };
    }>>;
    ready: (l: T.PublicIdentityOutputCapture, options: T.PublicIdentityOutputWork) => Promise<T.PublicIdentityOutputResult<{
        status: 'ready';
        seal: {
            capture: Readonly<{
                kind: 'public-output';
                partition: number;
                captureId: string;
                bindingDigest: string;
            }>;
            manifestDigest: string;
            native: Readonly<{
                partition: number;
                epoch: number;
                position: bigint;
                transactionId: string;
            }>;
        };
        committedRevision: bigint;
    }>>;
    revalidate: (l: T.PublicIdentityOutputCapture, options: T.PublicIdentityOutputWork) => Promise<T.PublicIdentityOutputResult<{
        status: 'ready';
        seal: {
            capture: Readonly<{
                kind: 'public-output';
                partition: number;
                captureId: string;
                bindingDigest: string;
            }>;
            manifestDigest: string;
            native: Readonly<{
                partition: number;
                epoch: number;
                position: bigint;
                transactionId: string;
            }>;
        };
        committedRevision: bigint;
    }>>;
    membership: (l: T.PublicIdentityOutputCapture, originals: readonly string[], options: T.PublicIdentityOutputWork) => Promise<T.PublicIdentityOutputResult<{
        status: 'ready';
        terminals: string[];
        after: string | null;
        seal: {
            capture: Readonly<{
                kind: 'public-output';
                partition: number;
                captureId: string;
                bindingDigest: string;
            }>;
            manifestDigest: string;
            native: Readonly<{
                partition: number;
                epoch: number;
                position: bigint;
                transactionId: string;
            }>;
        };
    }>>;
    prefix: (l: T.PublicIdentityOutputCapture, after: string | null, limit: number, options: T.PublicIdentityOutputWork) => Promise<T.PublicIdentityOutputResult<{
        status: 'ready';
        terminals: string[];
        after: string | null;
        seal: {
            capture: Readonly<{
                kind: 'public-output';
                partition: number;
                captureId: string;
                bindingDigest: string;
            }>;
            manifestDigest: string;
            native: Readonly<{
                partition: number;
                epoch: number;
                position: bigint;
                transactionId: string;
            }>;
        };
    }>>;
    enrollConsumer: (l: T.PublicIdentityOutputCapture, consumerId: string, options: T.PublicIdentityOutputWork) => Promise<T.PublicIdentityOutputResult<{
        status: 'enrolled';
        capture: Readonly<{
            kind: 'public-output';
            partition: number;
            captureId: string;
            bindingDigest: string;
        }>;
        consumerId: string;
    }>>;
    cancel: (l: T.PublicIdentityOutputCapture, options: T.PublicIdentityOutputWork) => Promise<T.PublicIdentityOutputResult<{
        status: 'pending';
        capture: Readonly<{
            kind: 'public-output';
            partition: number;
            captureId: string;
            bindingDigest: string;
        }>;
    } | {
        status: "applied" | "cancelled";
        capture: Readonly<{
            kind: 'public-output';
            partition: number;
            captureId: string;
            bindingDigest: string;
        }>;
        disposition: Readonly<{
            partition: number;
            epoch: number;
            position: bigint;
            transactionId: string;
        }>;
    }>>;
    apply: (l: T.PublicIdentityOutputCapture, options: T.PublicIdentityOutputWork) => Promise<T.PublicIdentityOutputResult<{
        status: "applied" | "cancelled";
        capture: Readonly<{
            kind: 'public-output';
            partition: number;
            captureId: string;
            bindingDigest: string;
        }>;
        disposition: Readonly<{
            partition: number;
            epoch: number;
            position: bigint;
            transactionId: string;
        }>;
    }>>;
};
/** Commerce calls this on the actual original Collection command. No caller payload is evidence. */
export declare const resolvePublicIdentityOutputCaptureDisposition: LockPublicOutputDisposition<CommandTransaction, Pool, AuthoritativeTime>;
/** Source-local current guard for the explicit variant. The caller transfers its own remainder. */
export declare function lockPublicIdentityOutputCaptureCurrent(tx: CommandTransaction, selection: T.PublicIdentityOutputCapture | IdentityScopeKey, ctx: PublicOutputCommandContext<Pool, AuthoritativeTime>, nativeOutput: NativePublicOutputPort, retained?: boolean): Promise<{
    status: "current" | "retained";
    key: {
        source: {
            kind: 'library';
            identity: Readonly<{
                scope: 'public_output';
                route: number;
                collectionId: string;
                incarnation: string;
                generation: string;
                ownerEpoch: number;
                receivingEpoch: string;
                effectKey: string;
                outputGeneration: string;
                activation: import("../library/native-source-output-types.ts").NativeOutputActivation;
            }>;
        };
        scopeId: string;
    };
    capture: Readonly<{
        kind: 'public-output';
        partition: number;
        captureId: string;
        bindingDigest: string;
    }>;
    committedRevision: bigint;
    work: import("../library/collection-source.ts").WorkReceipt;
} | {
    status: "changed" | "unavailable";
    reason: "binding" | "closure" | "continuation" | "current" | "fenced" | "foreign_closure_missing" | "provenance";
    dependency?: string;
    work: import("../library/collection-source.ts").WorkReceipt;
}>;
export declare function readPublicIdentityOutputCaptureCurrent(pool: Pool, selection: T.PublicIdentityOutputCapture | IdentityScopeKey, options: T.PublicIdentityOutputWork, nativeOutput: NativePublicOutputPort): Promise<{
    status: "current" | "retained";
    key: {
        source: {
            kind: 'library';
            identity: Readonly<{
                scope: 'public_output';
                route: number;
                collectionId: string;
                incarnation: string;
                generation: string;
                ownerEpoch: number;
                receivingEpoch: string;
                effectKey: string;
                outputGeneration: string;
                activation: import("../library/native-source-output-types.ts").NativeOutputActivation;
            }>;
        };
        scopeId: string;
    };
    capture: Readonly<{
        kind: 'public-output';
        partition: number;
        captureId: string;
        bindingDigest: string;
    }>;
    committedRevision: bigint;
    work: import("../library/collection-source.ts").WorkReceipt;
} | {
    status: "changed" | "unavailable";
    reason: "binding" | "closure" | "continuation" | "current" | "fenced" | "foreign_closure_missing" | "provenance";
    dependency?: string;
    work: import("../library/collection-source.ts").WorkReceipt;
}>;
/** Original pre-arm receipts invalidate even a stale retained output; they never grant fresh eligibility. */
export declare function receivePublicIdentityOutputCapturePrearm(pool: Pool, selection: import('./identity-epoch-prearm-contract.ts').IdentityPrearmTicketLocator, options: T.PublicIdentityOutputWork, cancellation?: IdentityNativeReceipt): Promise<{
    status: 'received';
    native: Readonly<{
        partition: number;
        epoch: number;
        position: bigint;
        transactionId: string;
    }>;
    work: import("../library/collection-source.ts").WorkReceipt;
} | {
    status: "changed" | "unavailable";
    reason: "binding" | "closure" | "continuation" | "current" | "fenced" | "foreign_closure_missing" | "provenance";
    dependency?: string;
    work: import("../library/collection-source.ts").WorkReceipt;
}>;
export {};
