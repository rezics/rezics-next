import type { ContentBoardSort, ContentCursorAdmission, ContentRankCursorAdmission } from '../contract/index.ts';
import {
  admitBoardCursor,
  admitBoardRankCursor,
  isBoardCursorKey,
  isBoardRankCursorKey,
  normalizeBoardQuery,
} from '../core/index.ts';

export function createBoardCursors() {
  return {
    normalizeQuery: normalizeBoardQuery,
    admit(input: ContentCursorAdmission): ContentBoardSort | null {
      return admitBoardCursor(input);
    },
    admitRank(input: ContentRankCursorAdmission) {
      return admitBoardRankCursor(input);
    },
    isKey: isBoardCursorKey,
    isRankKey: isBoardRankCursorKey,
  };
}
