import { AsyncLocalStorage } from 'node:async_hooks';
import type { AccessWorkAccounting } from '../access/work.ts';
import type { WorkDimensions, WorkReceipt } from '../library/collection-source.ts';

/** Accounting-only request context, kept free of runtime SQL dependencies. */
export type CommandWorkReservation = Readonly<{
  settle(actual?: Partial<WorkDimensions>): void;
}>;

export type CommandWorkAssociation = Readonly<{
  deadline: number;
  access: AccessWorkAccounting;
  reserve(operation: string, bound: WorkDimensions | undefined): CommandWorkReservation;
  run<T>(
    operation: string,
    bound: WorkDimensions | undefined,
    dispatch: () => Promise<T>,
    actual?: (value: T) => Partial<WorkDimensions> | undefined,
  ): Promise<T>;
  receipt(): WorkReceipt;
  /** Settle the one up-front Source reservation after the enclosing request ends. */
  close(): Error | undefined;
}>;

const associations = new WeakSet<object>();
const requestFrame = new AsyncLocalStorage<CommandWorkAssociation>();
const libraryOperationFrame = new AsyncLocalStorage<string>();

export { withQueryAccounting as withNativeCommandAccounting } from '../database/pool.ts';

export function registerCommandWorkAssociation(association: CommandWorkAssociation): void {
  associations.add(association);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  return typeof Reflect.get(value, 'then') === 'function';
}

/** Keep the one frame across every executor retry while leaving ordinary calls untouched. */
export function withCommandWorkAssociation<T>(association: CommandWorkAssociation, body: () => Promise<T>): Promise<T>;
export function withCommandWorkAssociation<T>(association: CommandWorkAssociation, body: () => T): T;
export function withCommandWorkAssociation<T>(association: CommandWorkAssociation, body: () => T): T {
  if (!associations.has(association)) throw new TypeError('Invalid command work association');
  const current = requestFrame.getStore();
  if (current && current !== association) throw new TypeError('Nested command work association changed');
  let value: T;
  try {
    value = requestFrame.run(association, body);
  } catch (error) {
    if (current !== association) association.close();
    throw error;
  }
  // A nested same-frame scope does not own the frame's single settlement.
  if (current === association) return value;
  if (isPromiseLike(value)) {
    return Promise.resolve(value).then(
      (result) => {
        const failure = association.close();
        if (failure) throw failure;
        return result;
      },
      (error: unknown) => {
        association.close();
        throw error;
      },
    ) as T;
  }
  const failure = association.close();
  if (failure) throw failure;
  return value;
}

/** Executor-only lookup. An association is accounting context, never authority. */
export function currentCommandWorkAssociation(): CommandWorkAssociation | undefined {
  const association = requestFrame.getStore();
  if (association && !associations.has(association)) throw new TypeError('Invalid command work association');
  return association;
}

/** The enclosing Library operation owns its composed bound; nested SQL leaves do not reserve it again. */
export function withLibraryOperationAccounting<T>(operation: string, body: () => T): T {
  if (libraryOperationFrame.getStore()) return body();
  return libraryOperationFrame.run(operation, body);
}

/** Executor-only lookup for the existing Library leaf adapters. */
export function currentLibraryOperationAccounting(): string | undefined {
  return libraryOperationFrame.getStore();
}
