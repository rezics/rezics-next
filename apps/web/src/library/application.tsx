import { createContext, useContext, type ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { useReaderCurrentOrigin, useReaderAddress, useReaderResponseOrigin } from '../session/reader';
import type { WorkspaceAdmission } from '../session/reader';
import type { GatedOperation, OperationAdmission } from '../session/reader';

export type LibrarySession = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  subject?: string | null;
  csrfToken: string | null;
};

export type RecoveryObservation = { subject: string | null; csrfToken: string | null; identity: object };
export type RecoveryObserver = {
  read: () => RecoveryObservation;
  subscribe: (notify: () => void) => () => void;
};

/** Consumer capabilities, supplied by the application composition, never by a Library account store. */
export type LibraryApplication = {
  useSession: () => LibrarySession;
  recoveryObservation: (client: QueryClient | undefined) => RecoveryObserver;
  useOperation: (operation: GatedOperation) => boolean;
  useOperationAdmission: (operation: GatedOperation) => OperationAdmission;
  useWorkspaceAdmission: (operations: readonly GatedOperation[]) => {
    store: WorkspaceAdmission;
    value: ReturnType<WorkspaceAdmission['read']>;
  };
  useReaderCurrentOrigin: typeof useReaderCurrentOrigin;
  useReaderAddress: typeof useReaderAddress;
  useReaderResponseOrigin: typeof useReaderResponseOrigin;
};

export const LibraryApplicationContext = createContext<LibraryApplication | null>(null);

export function useLibraryApplication(): LibraryApplication {
  const application = useContext(LibraryApplicationContext);
  if (!application) throw new Error('Library requires application reading capabilities');
  return application;
}

export function useSession() {
  return useLibraryApplication().useSession();
}
export function useOperation(operation: GatedOperation) {
  return useLibraryApplication().useOperation(operation);
}
export function useOperationAdmission(operation: GatedOperation) {
  return useLibraryApplication().useOperationAdmission(operation);
}
export function Exposure({ operation, children }: { operation: GatedOperation; children: ReactNode }) {
  return useOperation(operation) ? children : null;
}
export function useLibraryWorkspaceAdmission(operations: readonly GatedOperation[]) {
  return useLibraryApplication().useWorkspaceAdmission(operations);
}
export type LibraryWorkspaceAdmission = WorkspaceAdmission;
export type { GatedOperation, OperationAdmission };
