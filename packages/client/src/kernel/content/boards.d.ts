import { type BoardCursorSort } from './board-cursor.ts';
import type { AnchoredPosition, Page, ReadContext, ThreadView } from './model.ts';
import { type ContentReadDependencies } from './reads.ts';
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
};
/** Candidate references carry no authority. Only the shared final reader can
 * supply view fields, the public floor, or the grant/scope/denial decision. */
export declare function listBoardThreads(dependencies: ContentBoardDependencies, boardId: string, context: ReadContext, input?: BoardPageInput): Promise<BoardThreadPage>;
