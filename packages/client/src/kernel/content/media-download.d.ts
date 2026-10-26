import { type Actor } from '../request/access.ts';
import type { DownloadDecision, DownloadVariant, MediaDependencies } from './media.ts';
export type DownloadContext = Readonly<{
    deadline: number;
    routeKey?: Uint8Array;
}>;
/** No image bytes or object-store operations cross this boundary. Prepared
 * facts are independently anchored and released, then revalidated at each home.
 * H is bounded by mediaParentChain; the final media query probes one exact slot.
 */
export declare function downloadMedia(dependencies: MediaDependencies, mediaId: string, actor: Actor, variant: DownloadVariant, context: DownloadContext): Promise<DownloadDecision>;
