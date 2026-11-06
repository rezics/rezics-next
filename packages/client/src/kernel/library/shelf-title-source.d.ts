import type { AccountActor } from '../request/access.ts';
import type { ShelfOwner } from './shelf-maintenance-ops-contract.ts';
/** Content must cover title, identity disclosure, redirects and source-owner changes in this version. */
export type ShelfTitleBasis = {
    status: 'current';
    version: string;
} | {
    status: 'unavailable';
};
export type ShelfTitleLabels = {
    subjectId: string;
    sourceId: string;
    sourceBasis: string;
    /** Missing labels are allowed; an undisclosed identity is not a missing label. */
    labels: Readonly<Record<string, string>>;
    originalLanguage?: string | null;
};
/**
 * Released, complete-input Content port. Neither method may hold a Library transaction.
 * basis is a bounded whole-source version, including current owner disclosure, never a page digest.
 * labels batches exact original subjects under that basis; denied/hidden/unknown identities return unavailable.
 * Implementations must not acquire one Subject per Entry or manufacture currentness from cached labels.
 */
export interface ShelfTitleSource {
    basis(owner: ShelfOwner, languages: readonly string[], viewer: AccountActor): Promise<ShelfTitleBasis>;
    labels(owner: ShelfOwner, languages: readonly string[], basis: string, subjectIds: readonly string[], viewer: AccountActor): Promise<{
        status: 'current';
        entries: readonly ShelfTitleLabels[];
    } | {
        status: 'unavailable';
    }>;
}
export declare function titleLanguages(value: unknown): string[];
export declare function shelfTitlePolicy(languages: readonly string[]): string;
export declare function currentShelfTitleBasis(source: ShelfTitleSource | undefined, owner: ShelfOwner, languages: readonly string[], viewer: AccountActor): Promise<string>;
