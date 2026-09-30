import type { FusekiClient, SparqlResult } from '../../infrastructure/fuseki.ts';
import { FusekiQueryResponseTooLarge } from '../../infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { MAX_SEARCH_RESPONSE_BYTES } from '../work/search-readiness.ts';
import { WorkReadUnavailable } from '../work/read-session.ts';
import { knownSearchPosition, searchGraphSnapshot } from './snapshot-state.ts';
import { inheritDisclosure } from '../disclosure/read.ts';

interface PendingRead { query: string; resolve: (result: SparqlResult) => void; reject: (error: unknown) => void }

/** Independent card fact families share a SELECT transaction. Each subquery
 * retains its own LIMIT and projection; UNION avoids multiplying fact rows.
 * https://www.w3.org/TR/sparql11-query/#subqueries
 * Only the owner's leading PREFIX declarations are lifted, never query text.
 * At most four fact reads / 1 MiB per round trip, within the search budget. */
function batchQuery(queries: readonly string[]) {
  const prefixes = new Map<string, string>();
  const branches = queries.map((query, index) => {
    let body = query.trimStart();
    for (;;) {
      const prefix = /^PREFIX\s+([\w-]*):\s*(<[^>]+>)\s*/i.exec(body);
      if (!prefix) break;
      const name = prefix[1]!, iri = prefix[2]!;
      if (prefixes.has(name) && prefixes.get(name) !== iri) throw new WorkReadUnavailable('Card prefix differs');
      prefixes.set(name, iri);
      body = body.slice(prefix[0].length);
    }
    if (!/^SELECT\s/i.test(body) || /\?searchCardRead\b/.test(body)) {
      throw new WorkReadUnavailable('Card facts require an independent SELECT');
    }
    return `{ { ${body} } BIND("${index}" AS ?searchCardRead) }`;
  });
  return `${[...prefixes].map(([name, iri]) => `PREFIX ${name}: ${iri}`).join('\n')}
    SELECT * WHERE { ${branches.join(' UNION ')} }`;
}

/** This cache is valid only under the route's final, uncached graph fence.
 * Repeated summary reads still check live title restrictions and media rows;
 * only their graph facts are reused. Direct Work reads keep their own fences. */
export function searchCardReadDependencies(deps: MainWorkDependencies): MainWorkDependencies {
  const native = deps.environment.fuseki;
  if (!knownSearchPosition(native, deps.environment.lineage)) return deps;
  const snapshot = searchGraphSnapshot.getStore()!;
  const cached = new Map<string, Promise<SparqlResult>>();
  let pending: PendingRead[] = [];
  async function flush() {
    const reads = pending;
    pending = [];
    try {
      if (reads.length > 4) throw new WorkReadUnavailable('Card fact batch exceeds its bound');
      const result = await native.query(reads.length === 1 ? reads[0]!.query
        : batchQuery(reads.map(read => read.query)), MAX_SEARCH_RESPONSE_BYTES);
      if (reads.length === 1) { reads[0]!.resolve(result); return; }
      const groups: NonNullable<SparqlResult['results']>['bindings'][] = reads.map(() => []);
      for (const { searchCardRead, ...row } of result.results?.bindings ?? []) {
        const index = searchCardRead?.value;
        if (!index || !/^[0-3]$/.test(index) || !groups[Number(index)]) {
          throw new WorkReadUnavailable('Card fact batch returned an unrelated row');
        }
        groups[Number(index)]!.push(row);
      }
      reads.forEach((read, index) => read.resolve({ results: { bindings: groups[index]! } }));
    } catch (error) { reads.forEach(read => read.reject(error)); }
  }
  const client = new Proxy(native, { get(target, key) {
    if (key === 'query') return async (query: string, maxBytes = MAX_SEARCH_RESPONSE_BYTES) => {
      if (searchGraphSnapshot.getStore() !== snapshot) return native.query(query, maxBytes);
      let read = cached.get(query);
      if (!read) {
        read = new Promise<SparqlResult>((resolve, reject) => {
          pending.push({ query, resolve, reject });
          if (pending.length === 1) queueMicrotask(() => { void flush(); });
        });
        cached.set(query, read);
      }
      const result = await read;
      if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new FusekiQueryResponseTooLarge();
      // Owners may sort or annotate their own rows without changing cached facts.
      return structuredClone(result);
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as FusekiClient;
  snapshot.clients.add(client);
  const environment = { ...deps.environment, fuseki: client };
  inheritDisclosure(deps.environment, environment);
  return { ...deps, environment };
}
