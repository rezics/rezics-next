import { type BoardCursorSort } from './board-cursor.ts';
import type { Anchored, AnchoredPosition, BoardView, Page, ReadContext } from './model.ts';
import { type ContentReadDependencies, type ThreadView } from './reads.ts';
export type ContentBoardDependencies = ContentReadDependencies & {
    /** Trusted service configuration, independent of authentication's wall clock. */
    cursorNow?: () => number;
};
export type BoardPageInput = {
    cursor?: string;
    limit?: number;
    sort?: BoardCursorSort;
    query?: string;
};
export type BoardThreadPage = Page<ThreadView> & {
    anchors: readonly AnchoredPosition[];
    /** The oldest returned active-rank row's materialization time, or null when no active row was returned. */
    rankRefreshedAt: string | null;
};
export type RealmBoardPageInput = {
    cursor?: string;
    limit?: number;
};
export type RealmBoardPage = {
    items: readonly BoardView[];
    next: string | null;
    anchors: readonly AnchoredPosition[];
};
/** A Realm is the read container for every Realm-owned board. Legacy boards
 * have no Realm and retain their existing board-only disclosure behavior. */
export declare function readRealmBoard(dependencies: ContentBoardDependencies, boardId: string, context: ReadContext): Promise<Anchored<BoardView | null>>;
/** Keyset page of one Realm's boards. Candidate ids carry no authority; each
 * returned item goes through the current board and Realm disclosure checks. */
export declare function listRealmBoards(dependencies: ContentBoardDependencies, realmId: string, context: ReadContext, input?: RealmBoardPageInput): Promise<RealmBoardPage>;
/** Candidate references carry no authority. Only the shared final reader can
 * supply view fields, the public floor, or the grant/scope/denial decision. */
export declare function listBoardThreads(dependencies: ContentBoardDependencies, boardId: string, context: ReadContext, input?: BoardPageInput): Promise<BoardThreadPage>;
