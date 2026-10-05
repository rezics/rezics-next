import type { FusekiClient } from '../../../../services/main/src/infrastructure/fuseki.ts';
import { isForegroundOperation } from './operation-cost.ts';

/** Observe real operation responses, including fences and hydration. */
export async function measureGraphResponses<T>(fuseki: FusekiClient, read: () => Promise<T>) {
  const original = fuseki.query;
  const query = original.bind(fuseki);
  let graphCalls = 0,
    graphRows = 0;
  fuseki.query = async (sparql, maxBytes) => {
    const foreground = isForegroundOperation();
    if (foreground) graphCalls++;
    const result = await query(sparql, maxBytes);
    if (foreground)
      graphRows += result.results?.bindings.length ?? (result.boolean === undefined ? 0 : 1);
    return result;
  };
  const started = performance.now();
  try {
    const value = await read();
    return { value, cost: { graphCalls, graphRows }, ms: Math.round(performance.now() - started) };
  } finally {
    fuseki.query = original;
  }
}
