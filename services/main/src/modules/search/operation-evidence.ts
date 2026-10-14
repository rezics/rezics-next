import { AsyncLocalStorage } from 'node:async_hooks';

export interface SearchPhaseEvidence {
  phase: string;
  startedMs: number;
  elapsedMs?: number;
  state: 'active' | 'complete' | 'failed';
}

/** An owning-operation observer never adds a graph read, retry or deadline. */
export const searchOperationEvidence = new AsyncLocalStorage<{ phases: SearchPhaseEvidence[] }>();

export async function observeSearchPhase<T>(phase: string, read: () => Promise<T>): Promise<T> {
  const evidence = searchOperationEvidence.getStore();
  if (!evidence) return read();
  const startedMs = performance.now();
  const entry: SearchPhaseEvidence = { phase, startedMs, state: 'active' };
  evidence.phases.push(entry);
  try {
    const result = await read();
    entry.state = 'complete';
    return result;
  } catch (error) {
    entry.state = 'failed';
    throw error;
  } finally { entry.elapsedMs = performance.now() - startedMs; }
}
