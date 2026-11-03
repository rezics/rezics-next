import {
  EPISODE_INSPECT_CAP,
  EPISODE_RETAINED_PAGE,
  MEMBERSHIP_PAGE_CAP,
  type ChecklistRow,
} from './contract';

/** One visit: work-parts subject + one association page plus one ≤20-ID native inspection. */
export const CHECKLIST_VISIT_COMPONENTS = {
  subject: 1,
  membership: 1,
  inspect: 1,
  command: 1,
  readback: 1,
} as const;

export const CHECKLIST_VISIT_READ_CALLS =
  CHECKLIST_VISIT_COMPONENTS.subject + CHECKLIST_VISIT_COMPONENTS.membership + CHECKLIST_VISIT_COMPONENTS.inspect;

export type ChecklistWork = {
  nativeCalls: readonly string[];
  nativeCallCount: number;
  valuesProcessed: number;
  valuesRendered: number;
  bytesRetained: number;
  membershipRows: number;
  inspectRows: number;
  retainedRows: number;
  components: typeof CHECKLIST_VISIT_COMPONENTS;
};

export function retainedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function emptyChecklistWork(): ChecklistWork {
  return {
    nativeCalls: [],
    nativeCallCount: 0,
    valuesProcessed: 0,
    valuesRendered: 0,
    bytesRetained: 0,
    membershipRows: 0,
    inspectRows: 0,
    retainedRows: 0,
    components: CHECKLIST_VISIT_COMPONENTS,
  };
}

export function finishChecklistWork(
  calls: readonly string[],
  rows: readonly ChecklistRow[],
  retained: unknown,
  membershipRows: number,
  inspectRows: number,
  retainedRows = 0,
): ChecklistWork {
  const rendered = Math.min(rows.length, MEMBERSHIP_PAGE_CAP + EPISODE_RETAINED_PAGE);
  return {
    nativeCalls: [...calls],
    nativeCallCount: calls.length,
    valuesProcessed: membershipRows + inspectRows + retainedRows,
    valuesRendered: rendered,
    bytesRetained: retainedBytes(retained),
    membershipRows,
    inspectRows,
    retainedRows,
    components: CHECKLIST_VISIT_COMPONENTS,
  };
}

export function workWithinBound(work: ChecklistWork, historyLength: number): boolean {
  return (
    work.nativeCallCount <= CHECKLIST_VISIT_READ_CALLS &&
    work.membershipRows <= MEMBERSHIP_PAGE_CAP &&
    work.inspectRows <= EPISODE_INSPECT_CAP &&
    work.retainedRows <= EPISODE_RETAINED_PAGE &&
    work.valuesRendered <= MEMBERSHIP_PAGE_CAP + EPISODE_RETAINED_PAGE &&
    historyLength >= 0
  );
}

const counted = new Set(['get', 'post', '$recordEpisodes', 'relations', 'links']);

function wrap(value: unknown, onCall: (name: string) => void, name: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  return countPoint(value as object, onCall, name);
}

function countPoint(target: object, onCall: (name: string) => void, name: string): object {
  return new Proxy(target, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      const label = String(key);
      const next = `${name}.${label}`;
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          if (counted.has(label)) onCall(next);
          return wrap(value.apply(target, args), onCall, next);
        };
      }
      return wrap(value, onCall, next);
    },
    apply(target, thisArg, args) {
      return wrap(Reflect.apply(target as (...args: unknown[]) => unknown, thisArg, args), onCall, name);
    },
  });
}

/** Count native episode and membership calls at the loader boundary. */
export function observeChecklistWork<T extends { progressSessions: unknown; subjects?: unknown }>(
  client: T,
  onCall: (name: string) => void,
): T {
  return new Proxy(client, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === 'progressSessions' || key === 'subjects') return countPoint(value as object, onCall, String(key));
      return value;
    },
  }) as T;
}
