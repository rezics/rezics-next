/**
 * Compatibility: Access callers reach shared History admission through the installed application.
 */
export {
  admitSharedHistory,
  advanceSharedHistory,
  redriveSharedHistory,
} from '../history/application/index.ts';
export type { SharedHistoryResult } from '../history/contract/index.ts';
