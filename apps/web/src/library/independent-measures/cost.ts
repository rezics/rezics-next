import { PROGRESS_MEASURE_CAP } from '../progress-reads';
import type { IndependentMeasure } from './contract';

/** Fixed native components for one independent-measure visit; never a function of owner history N. */
export const INDEPENDENT_VISIT_COMPONENTS = {
  session: 1,
  command: 1,
  readback: 1,
} as const;

export const INDEPENDENT_VISIT_READ_CALLS = INDEPENDENT_VISIT_COMPONENTS.session;
export const INDEPENDENT_MEASURE_BYTE_HINT = 256;

export type IndependentWork = {
  nativeCalls: readonly string[];
  nativeCallCount: number;
  valuesProcessed: number;
  valuesRendered: number;
  bytesRetained: number;
  admittedFields: number;
  fieldCap: number;
  components: typeof INDEPENDENT_VISIT_COMPONENTS;
};

export function emptyIndependentWork(admittedFields = 0): IndependentWork {
  return {
    nativeCalls: [],
    nativeCallCount: 0,
    valuesProcessed: 0,
    valuesRendered: 0,
    bytesRetained: 0,
    admittedFields,
    fieldCap: PROGRESS_MEASURE_CAP,
    components: INDEPENDENT_VISIT_COMPONENTS,
  };
}

export function retainedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function finishIndependentWork(
  calls: readonly string[],
  measures: readonly IndependentMeasure[],
  retained: unknown,
): IndependentWork {
  const admitted = Math.min(measures.length, PROGRESS_MEASURE_CAP);
  return {
    nativeCalls: [...calls],
    nativeCallCount: calls.length,
    valuesProcessed: admitted,
    valuesRendered: admitted,
    bytesRetained: retainedBytes(retained),
    admittedFields: admitted,
    fieldCap: PROGRESS_MEASURE_CAP,
    components: INDEPENDENT_VISIT_COMPONENTS,
  };
}

export function workWithinBound(work: IndependentWork, historyLength: number): boolean {
  return (
    work.nativeCallCount === INDEPENDENT_VISIT_READ_CALLS &&
    work.valuesProcessed <= PROGRESS_MEASURE_CAP &&
    work.admittedFields <= PROGRESS_MEASURE_CAP &&
    work.components.session === 1 &&
    work.components.command === 1 &&
    historyLength >= 0
  );
}

const counted = new Set(['get', 'post', '$record']);

function countPoint(target: object, onCall: (name: string) => void, name: string): object {
  return new Proxy(target, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      if (counted.has(String(key))) {
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

/** Count native progress session calls at the loader boundary without changing operands. */
export function observeIndependentWork<T extends { progressSessions: unknown }>(client: T, onCall: (name: string) => void): T {
  return new Proxy(client, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === 'progressSessions') return countPoint(value as object, onCall, 'progressSessions');
      return value;
    },
  }) as T;
}
