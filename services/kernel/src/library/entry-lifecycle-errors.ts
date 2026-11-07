/** Shared entry failures retain their memoized constructor identities without loading entry commands. */
import { memoizedValue } from '../memoized.ts';
import { LibraryConflictError } from './entry-errors.ts';
export class LibraryEntryInvalidError extends TypeError {
  constructor(message = 'Unknown library entry state') {
    super(message);
    this.name = 'LibraryEntryInvalidError';
  }
}

export function LibraryEntryLifecycleConflictError() {
  return memoizedValue(
    LibraryEntryLifecycleConflictError,
    () =>
      class LibraryEntryLifecycleConflictError extends LibraryConflictError {
        constructor(readonly reason: 'stale' | 'occupied' | 'expired') {
          super();
        }
      },
  );
}

export type LibraryEntryLifecycleConflictError = InstanceType<ReturnType<typeof LibraryEntryLifecycleConflictError>>;

export function LibraryEntryStateRestoreConflictError() {
  return memoizedValue(
    LibraryEntryStateRestoreConflictError,
    () =>
      class LibraryEntryStateRestoreConflictError extends LibraryConflictError {
        constructor(readonly reason: 'stale' | 'unavailable' | 'unchanged') {
          super();
          this.name = 'LibraryEntryStateRestoreConflictError';
        }
      },
  );
}

export type LibraryEntryStateRestoreConflictError = InstanceType<
  ReturnType<typeof LibraryEntryStateRestoreConflictError>
>;
