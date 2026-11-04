/** Web browser adapter entry. Server authentication remains in request.ts. */
export { browserObservation, type BrowserObservationSnapshot, type BrowserReader, type BrowserCacheEvent } from './observation';
export type { BrowserSession } from './browser-state';
export { addressLease, readLease, operationLease, type AddressLease, type ReadLease, type OperationLease } from '../reader/lease';
export { workspaceAdmission, useWorkspaceAdmission, type WorkspaceAdmission } from '../reader/workspace-admission';
export { assertReaderCurrent, useReaderAddress, useReaderCurrentOrigin, useReaderResponseOrigin, type ReaderOrigin } from '../reader/current-origin';
