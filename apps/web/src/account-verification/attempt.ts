import { validOperation, type Operation } from './transport';

export type AttemptStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** An unfinished input is a retry draft, never evidence of authority or a successful decision. */
export function readAttempt(storage: AttemptStore, scope: string): Operation | null {
  const raw = storage.getItem(scope);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return validOperation(value) ? value : null;
  } catch {
    return null;
  }
}
export function saveAttempt(storage: AttemptStore, scope: string, operation: Operation) {
  storage.setItem(scope, JSON.stringify(operation));
}
export function clearAttempt(storage: AttemptStore, scope: string) {
  storage.removeItem(scope);
}
