/** History vocabulary is a thin adapter over Web reader infrastructure. */
export {
  type ReaderOrigin as HistoryOrigin,
  useReaderCurrentOrigin as useHistoryCurrentOrigin,
  assertReaderCurrent as assertHistoryCurrent,
  useReaderAddress as useHistoryAddress,
  useReaderResponseOrigin as useHistoryReadOrigin,
} from '../session';
