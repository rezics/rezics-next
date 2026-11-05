import type { AccountActor } from '../request/access.ts';
import type { ShelfOwner } from './shelf-maintenance-ops-contract.ts';
import { type ShelfTitleLabels, type ShelfTitleSource } from './shelf-title-source.ts';
/** Content owns this observation; Library neither reads Subjects nor produces a source version.
 * The version covers the complete title/identity/disclosure/redirect/source-owner input, including
 * foreign owners, independently of `subjects`. It must change on every relevant change, even when
 * no requested subject changed. Unsettled ownership or incomplete observations return unavailable.
 * Each observation releases all source snapshots before returning. With no subjects it reads only
 * the bounded whole-source basis; otherwise it observes <=100 exact originals under that same basis.
 */
export interface ContentShelfTitleInputs {
    observe(input: {
        owner: ShelfOwner;
        languages: readonly string[];
        viewer: AccountActor;
        subjects: readonly string[];
    }): Promise<{
        status: 'unavailable';
    } | {
        status: 'current';
        version: string;
        entries: readonly (({
            state: 'disclosed';
        } & ShelfTitleLabels) | {
            state: 'unavailable';
            subjectId: string;
        })[];
    }>;
}
/** Exact adapter for the native Library port, installed only by trusted Content composition. */
export declare function createContentShelfTitleSource(inputs: ContentShelfTitleInputs): ShelfTitleSource;
