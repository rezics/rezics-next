import { type AuthoritativeTime } from '../command/command.ts';
import type { Actor } from '../request/access.ts';
import type { DownloadDecision, DownloadVariant, MediaDependencies } from './media.ts';
import read from './read-download-media.sql.d.ts';
import { type AccessWorkAccounting } from '../access/work.ts';
type Row = NonNullable<Awaited<ReturnType<typeof read.run>>>;
export type DownloadContext = Readonly<{
    deadline: number;
    routeKey?: Uint8Array;
    /** Trusted caller forwarding only; never reconstructed from an HTTP timestamp. */
    time?: AuthoritativeTime;
    work?: AccessWorkAccounting;
}>;
export declare function downloadMedia(dependencies: MediaDependencies, mediaId: string, actor: Actor, variant: DownloadVariant, context: DownloadContext): Promise<DownloadDecision>;
/** Internal authenticated transport facts. The supplied row is an expectation,
 * never permission: the ordinary download verifier checks it before and at final
 * disclosure. No retry selects a replacement when that expectation changes. */
export declare function authorizeMediaDerivative(dependencies: MediaDependencies, mediaId: string, actor: Actor, variant: Exclude<DownloadVariant, 'original'>, context: DownloadContext, expected: Row): Promise<Row | null>;
export {};
