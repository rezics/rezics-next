import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
export declare const CANONICAL_GENERATION_PAGE_SIZE = 200;
export type CanonicalGenerationDelivery = Readonly<{
    partition: number;
    generation: string;
}>;
export type CanonicalGenerationPageRequest = Readonly<{
    after: number | null;
    limit: number;
}>;
export type CanonicalGenerationReceiver = (tx: CommandTransaction, generation: CanonicalGenerationDelivery, event: CloudEvent) => Promise<Readonly<{
    partition: number;
    canonicalGeneration: string;
    revision: string;
    complete: boolean;
}>>;
/** One keyset seek over the existing <=4096 home counters, including retained empty homes.
 * This is delivery inventory, not a second name/population observer or a coverage certificate.
 * The connection is released before the caller starts any command or foreign work.
 */
export declare function readCanonicalGenerationDeliveryPage(pool: Pool, input: CanonicalGenerationPageRequest, { deadline }: Readonly<{
    deadline: number;
}>): Promise<Readonly<{
    homes: readonly CanonicalGenerationDelivery[];
    after: number | null;
}>>;
/** Source-only recovery entry. Each emitted notification uses runCommand's real home envelope.
 * The generation is re-read under that command; a sequence increment or an old event cannot
 * supply it. The native log retains the keyset continuation, so there is no second cursor table.
 * Replays may coalesce to a newer generation, but never reset Rating's existing rebuild cursor.
 *
 * Literal page cost: one <=200-row inventory seek, <=200 single-home commands (one keyed
 * counter read each), and at most one continuation command. No Subject or Rating rows are read.
 */
export declare function resumeCanonicalGenerationDelivery(pool: Pool, input?: CanonicalGenerationPageRequest): Promise<void>;
/** Run one receiving page under the native home command. A full page commits a continuation
 * with the original notification intact. A terminal page and its checked watermark commit
 * together, so a failed receiver or a bad witness leaves both unchanged.
 */
export declare function deliverCanonicalGenerationEvent(pool: Pool, event: CloudEvent, receive: CanonicalGenerationReceiver): Promise<void>;
/** Existing mutation events are wake hints, never evidence of complete canonical coverage.
 * Mechanical delivery/locator events are excluded to avoid a notification feedback loop.
 * Startup always revisits the retained counters, recovering missing or exhausted deliveries.
 */
export declare function createCanonicalGenerationWakeEffect(pool: Pool): Effect;
