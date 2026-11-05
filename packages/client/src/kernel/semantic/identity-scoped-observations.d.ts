import type { Pool } from 'pg';
import type { WorkContext } from '../work/registry.ts';
import { type CommandTransaction } from '../command/command.ts';
import { type LibraryScopeEffectSeal } from '../library/identity-scope-effects.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import type * as S from './identity-scope-types.ts';
import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
import type { IdentityPrearmTicketData } from './identity-epoch-prearm-contract.ts';
import type { IdentitySourceConsumerContext, IdentitySourceScopeConsumerWork } from './identity-source-consumer-custody.ts';
/** Resolve the retained registration/capture using the existing Source frame.
 * The historical capture allowance is never consulted as a remaining balance.
 */
export declare function readIdentityScopeConsumerWork(pool: Pool, ticket: IdentityPrearmTicketData, context: IdentitySourceConsumerContext): Promise<IdentitySourceScopeConsumerWork | null>;
/** Only exact original owner statements have known accounting. In particular,
 * Library seal and receiving SQL need their owners' actual footprints; unfamiliar
 * SQL remains undefined and is refused by NativeCollectionWork before dispatch.
 * Each native projection below is fixed or schema-bounded (seal <=4096 bytes).
 */
export declare function scopeConsumerFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
/** Incarnation identifies the Source; per-effect receiving hints never create a second Source registry. */
export declare function identityScopeAddress(key: S.IdentityScopeKey): {
    partition: number;
    source: string;
    scope: string;
};
export declare function createIdentityScopedObservations(pool: Pool): S.IdentityScopedObservations;
/** Retained fair repair shares the native maintenance queue; workflow arguments contain only a home. */
export declare function registerIdentityScopedObservationWork({ pool, client, clock }: WorkContext): Promise<void>;
/** Source-owned unsafe receiving, also used for exact closed-attempt cancellation reconciliation. */
export declare function receiveScopePreparation(pool: Pool, ticket: IdentityPrearmTicketData, cancellation?: IdentityNativeReceipt): Promise<IdentityNativeReceipt>;
/** Source-local native obligation, called only after the terminal owner has checked
 * Library's current seal in this same command. Rechecking here prevents an unrelated
 * seal, a completed prefix, or a released receipt read from becoming a durable fence.
 * The returned component is usable only within this transaction until commit.
 */
export declare function retainIdentityScopeConsumerFence(tx: CommandTransaction, ticket: IdentityPrearmTicketData, seal: LibraryScopeEffectSeal): Promise<IdentityNativeReceipt | null>;
