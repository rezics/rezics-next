import type { CommandTransaction } from '../command/command.ts';
import type { LibraryProfileAnchor, LibraryProfileSource } from './profile-source.ts';
export type VndbEntryReview = {
    uploadId: string;
    ordinal: number;
    reviewId: string;
    source: string;
};
export declare function vndbSourceFingerprint(observation: {
    anchor: LibraryProfileAnchor;
    source: NonNullable<LibraryProfileSource>;
}): string;
/** Runs inside the native entry command after receipt lookup, before any fresh effect.
 * The same owner row lock orders cancellation/deletion against entry admission. */
export declare function admitVndbEntry(tx: CommandTransaction, accountId: string, route: number, review: VndbEntryReview): Promise<void>;
