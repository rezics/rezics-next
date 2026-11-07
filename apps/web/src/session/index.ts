/** Web browser adapter entry. Server authentication remains in request.ts. */
export {
  browserObservation,
  type BrowserObservationSnapshot,
  type BrowserReader,
  type BrowserCacheEvent,
} from './observation';
export { cachedBrowserSession, sessionQueryKey, type BrowserSession } from './browser-state';
export {
  addressLease,
  readLease,
  operationLease,
  type AddressLease,
  type ReadLease,
  type OperationLease,
} from '../reader/lease';
export { SessionRecoveryPage } from './recovery';
export { sessionQuery, useSession, sessionCsrfToken, AnonymousSessionContext } from './query';
export { ReaderNavigationContext, useReaderNavigationHost } from '../reader/lifetime/index';

export { checkoutCurrentVisit } from './checkout-visit';
