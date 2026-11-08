import { type CommandTransaction } from '../command/command.ts';
import type { Pool, PoolClient } from 'pg';
import { type OperationalTransaction } from '../command/operational.ts';
import type { WorkClient } from '../work/client.ts';
export { LiveCopyPendingError } from './contract/errors.ts';
/** Internal native business-copy protocol. It grants no Access or Source authority. */
export type LiveCopyModule = 'commerce.creator-sale' | 'library.subject-listing';
export type LiveCopyRole = Readonly<{
    accountId: string;
    roles: number;
}>;
export type LiveCopyLocator = Readonly<{
    route: number;
    transitionId: string;
}>;
export type LiveCopyDomain = Readonly<{
    partition: number;
    domainId: string;
    epoch: number;
    node: string;
}>;
export type LiveCopy = Readonly<{
    route: number;
    transition_id: string;
    module: LiveCopyModule;
    source_domain: string;
    source_epoch: number;
    effect_key: Record<string, unknown>;
    receiver_route: number;
    receiver_domain: string;
    receiver_epoch: number;
    payload: Record<string, unknown> | null;
    roles: readonly LiveCopyRole[] | null;
    state: 'pending' | 'complete' | 'retired';
    result_id: string | null;
    outcome: LiveCopyResult['outcome'] | null;
}>;
export type LiveCopyResult = Readonly<{
    resultId: string;
    outcome: 'applied' | 'cancelled' | 'superseded';
}>;
export type LiveCopyDependencies = {
    pool: Pool;
    client: WorkClient;
};
type Client = Pick<PoolClient, 'query'>;
export type LiveCopyAdmissions = {
    readonly nativeAdmissions: unique symbol;
};
export declare function liveCopyLocator(copy: LiveCopy): LiveCopyLocator;
/** Exact original native event role basis; no caller/event-JSON role inference. */
export declare function liveCopyEventRoles(tx: Client, input: {
    partition: number;
    position: string;
    eventSeq: number;
    requireInventory?: boolean;
}, extra: readonly LiveCopyRole[]): Promise<readonly Readonly<{
    accountId: string;
    roles: number;
}>[]>;
/** Native placement must have been admitted by migration, never initialized by a writer. */
export declare function readLiveCopyDomain(tx: Client, partition: number, lock?: boolean): Promise<LiveCopyDomain>;
export declare function observeLiveCopyDomain(pool: Pool, partition: number): Promise<Readonly<{
    partition: number;
    domainId: string;
    epoch: number;
    node: string;
}>>;
/** Called ONLY by the fixed Commerce/Library source adapter after its exact business read.
 * Original local role holds and the immutable source effect commit before release. */
export declare function stageLiveCopy(tx: OperationalTransaction, input: {
    route: number;
    module: LiveCopyModule;
    effectKey: Record<string, unknown>;
    payload: Record<string, unknown>;
    roles: readonly LiveCopyRole[];
    receiverRoute: number;
    receiver: LiveCopyDomain;
}): Promise<LiveCopy>;
/** All reads release their checkout before a role or receiver-home transaction. */
export declare function readLiveCopy(pool: Pool, locator: LiveCopyLocator): Promise<LiveCopy | null>;
/** Partial admission is retained. False requires exact receiver cancellation, then consume. */
export declare function admitLiveCopyRoles(deps: LiveCopyDependencies, copy: LiveCopy): Promise<boolean>;
/** Fixed Access adapter observes genuine holds, never an allow boolean supplied by a consumer. */
export declare function observeLiveCopyAdmissions(pool: Pool, copy: LiveCopy): Promise<LiveCopyAdmissions | null>;
/** Receiver-local arbitration. The caller is a fixed native module body, never a public callback. */
export declare function openLiveCopyGate(tx: OperationalTransaction | CommandTransaction, copy: LiveCopy, proof: LiveCopyAdmissions | null, cancel?: boolean): Promise<LiveCopyResult | null>;
export declare function finishLiveCopyGate(tx: OperationalTransaction | CommandTransaction, copy: LiveCopy, outcome: 'applied' | 'superseded'): Promise<{
    resultId: string;
    outcome: "applied" | "superseded";
}>;
export declare function readLiveCopyResult(pool: Pool, copy: LiveCopy): Promise<LiveCopyResult | null>;
export declare function cancelLiveCopy(deps: LiveCopyDependencies, copy: LiveCopy): Promise<LiveCopyResult>;
/** Receiver checkout is released BEFORE any source-account serialization.
 * Missing holds acquire a terminal role gate, barring a delayed first admission. */
export declare function consumeLiveCopy(deps: LiveCopyDependencies, copy: LiveCopy): Promise<LiveCopyResult | null>;
