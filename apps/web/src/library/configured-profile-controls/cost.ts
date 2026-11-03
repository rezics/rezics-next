import type { KernelClient } from '@rezics/client';
import { LIBRARY_PAGE_LIMIT } from '../reads';

/** Native reads that constitute one exact series/volume visit. Profile resolution is local. */
export const CONFIGURED_VISIT_COMPONENTS = {
  profile: 1,
  entry: 1,
  sessions: 1,
  copies: 1,
} as const;

export const CONFIGURED_VISIT_NATIVE_CALLS =
  CONFIGURED_VISIT_COMPONENTS.entry + CONFIGURED_VISIT_COMPONENTS.sessions + CONFIGURED_VISIT_COMPONENTS.copies;

export const CONFIGURED_PAGE_ROW_CAP = LIBRARY_PAGE_LIMIT;
/** Copies address cursor cap in copies-query.ts. */
export const CONFIGURED_PAGE_CURSOR_BYTE_CAP = 2048;
export const CONFIGURED_COPY_NOTE_CAP = 1000;
export const CONFIGURED_PROGRESS_LOCATOR_CAP = 256;

export type VisitWork = {
  nativeCalls: readonly string[];
  nativeCallCount: number;
  valuesProcessed: number;
  bytesRetained: number;
  admittedFields: number;
  pageRows: number;
  pageRowCap: number;
  pageCursorByteCap: number;
  components: typeof CONFIGURED_VISIT_COMPONENTS;
};

export function emptyVisitWork(admittedFields = 0): VisitWork {
  return {
    nativeCalls: [],
    nativeCallCount: 0,
    valuesProcessed: 0,
    bytesRetained: 0,
    admittedFields,
    pageRows: 0,
    pageRowCap: CONFIGURED_PAGE_ROW_CAP,
    pageCursorByteCap: CONFIGURED_PAGE_CURSOR_BYTE_CAP,
    components: CONFIGURED_VISIT_COMPONENTS,
  };
}

export function retainedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function finishVisitWork(
  calls: readonly string[],
  admittedFields: number,
  pageRows: number,
  projection: unknown,
): VisitWork {
  return {
    nativeCalls: [...calls],
    nativeCallCount: calls.length,
    valuesProcessed: admittedFields + pageRows,
    bytesRetained: retainedBytes(projection),
    admittedFields,
    pageRows,
    pageRowCap: CONFIGURED_PAGE_ROW_CAP,
    pageCursorByteCap: CONFIGURED_PAGE_CURSOR_BYTE_CAP,
    components: CONFIGURED_VISIT_COMPONENTS,
  };
}

const countedMethods = new Set(['get', 'post', 'patch', 'delete', '$record']);

function countPoint(target: object, onCall: (name: string) => void, name: string): object {
  return new Proxy(target, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      if (countedMethods.has(String(key))) {
        return (...args: unknown[]) => {
          onCall(`${name}.${String(key)}`);
          return value.apply(target, args);
        };
      }
      return (...args: unknown[]) => {
        const result = value.apply(target, args);
        return result && typeof result === 'object' ? countPoint(result as object, onCall, name) : result;
      };
    },
    apply(target, thisArg, args) {
      const result = Reflect.apply(target as (...args: unknown[]) => unknown, thisArg, args);
      return result && typeof result === 'object' ? countPoint(result as object, onCall, name) : result;
    },
  });
}

/** Count native Library calls at the loader boundary without changing their operands. */
export function observeLibraryWork(client: KernelClient, onCall: (name: string) => void): KernelClient {
  return new Proxy(client, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === 'copies' || key === 'libraryEntries' || key === 'progressSessions') {
        return countPoint(value as object, onCall, String(key));
      }
      return value;
    },
  });
}
