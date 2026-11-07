/** Browser reader capabilities. No request preparation, session fetch or Web feature dependency. */
export {
  browserObservation,
  type BrowserObservationSnapshot,
  type BrowserReader,
  type BrowserCacheEvent,
} from './observation';
export {
  cachedBrowserSession,
  ownedSessionCsrfToken,
  sessionCsrfToken,
  subscribeBrowserSession,
  sessionStateSnapshot,
} from './session-cache';
export {
  normalizeSessionObservation,
  unknownSession,
  signedOutSession,
  sessionQueryKey,
  type BrowserSession,
} from './contract';
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
