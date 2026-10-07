import { AsyncLocalStorage } from 'node:async_hooks';

const progress = new AsyncLocalStorage<() => Promise<void>>();
export const withImportJobProgress = <T>(pulse: () => Promise<void>,action: () => Promise<T>) => progress.run(pulse,action);
export const recordImportJobProgress = async () => { await progress.getStore()?.(); };
