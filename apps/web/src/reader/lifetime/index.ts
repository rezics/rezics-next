/** Browser reader capabilities. No request preparation, session fetch or Web feature dependency. */
export {
  browserObservation,
  type BrowserObservationSnapshot,
  type BrowserReader,
  type BrowserCacheEvent,
} from './observation';
export {
  cachedBrowserSession,
  normalizeSessionObservation,
  ownedSessionCsrfToken,
  sessionCsrfToken,
  subscribeBrowserSession,
  sessionStateSnapshot,
  unknownSession,
  signedOutSession,
  sessionQueryKey,
  type BrowserSession,
} from './session-cache';
export { readerSessionSource, type ReaderSessionSource } from './session-source';
export {
  addressLease,
  readLease,
  operationLease,
  type AddressLease,
  type ReadLease,
  type OperationLease,
} from './lease';
export { ReaderNavigationContext, useReaderNavigationHost, useReaderAddress, useReaderVisit } from './navigation';
export { useReaderActivityCurrent } from './activity';
