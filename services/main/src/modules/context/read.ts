import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState } from '../work/history.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { ContextCommandUnavailable } from './command.ts';
import { CONTEXT_LIMITS, CONTEXT_PROFILE, type ContextEntryRecord } from './schema.ts';
import { readDependencyToken, readRowsToken } from '../work/read-session.ts';
import { fusekiReadBudget, FusekiReadBudgetExceeded, FusekiQueryResponseTooLarge } from '../../infrastructure/fuseki.ts';

/** Two bounded passes: lineage, selectors, fallback, ≤9 pinned revisions and profile health. */
export const CONTEXT_READ_COST = { graphCalls: 2 * (CONTEXT_LIMITS.inheritanceDepth + 5),
  graphBytes: 2 * 1024 * 1024, deadlineMs: 10_000 } as const;
export async function contextReadBudget<T>(operation: () => Promise<T>): Promise<T> {
  const outer = fusekiReadBudget.getStore();
  const deadline = AbortSignal.timeout(CONTEXT_READ_COST.deadlineMs);
  const signal = outer ? AbortSignal.any([deadline, outer.signal]) : deadline;
  let calls: number = CONTEXT_READ_COST.graphCalls, bytes: number = CONTEXT_READ_COST.graphBytes;
  const budget = { signal,
    get callsLeft() { return Math.min(calls, outer?.callsLeft ?? calls); },
    set callsLeft(value: number) { const used = this.callsLeft - value; calls -= used; if (outer) outer.callsLeft -= used; },
    get bytesLeft() { return Math.min(bytes, outer?.bytesLeft ?? bytes); },
    set bytesLeft(value: number) { const used = this.bytesLeft - value; bytes -= used; if (outer) outer.bytesLeft -= used; },
  };
  try {
    const result = await fusekiReadBudget.run(budget, operation);
    signal.throwIfAborted(); return result;
  } catch (cause) {
    if (signal.aborted || cause instanceof FusekiReadBudgetExceeded || cause instanceof FusekiQueryResponseTooLarge) {
      throw new ContextCommandUnavailable('Context read exceeded its bounded budget', { cause });
    }
    throw cause;
  }
}

export class ContextNotFound extends Error {}

export interface ContextRevisionRead {
  profile: 'context-v1';
  context: string;
  role: 'global-interpretation' | 'shared-interpretation';
  state: 'active' | 'retired';
  disclosure: 'public' | 'private';
  semanticHead: string;
  revision: string;
  predecessor: string | null;
  base: string | null;
  inheritanceDepth: number;
  entries: ContextEntryRecord[];
  authoredBy: string;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string; dependencyToken: string };
}

/**
 * Read one exact semantic revision (the head when `revision` is null). A Private Context the
 * caller cannot read is reported exactly like a missing one, so its identity does not leak.
 * The entries come from the sealed manifest; missing or corrupt bytes are unavailable.
 */
export async function readContextRevision(env: WorkActivationEnvironment, context: string,
  revision: string | null, canReadPrivate: (context: string) => Promise<boolean>): Promise<ContextRevisionRead> {
  return contextReadBudget(() => readContextRevisionAtBasis(env, context, revision, canReadPrivate));
}

async function readContextRevisionAtBasis(env: WorkActivationEnvironment, context: string,
  revision: string | null, canReadPrivate: (context: string) => Promise<boolean>): Promise<ContextRevisionRead> {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const query = `PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?role ?state ?disclosure
    ?head ?revision ?manifest WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      GRAPH ${iri(GRAPHS.current)} { ${iri(context)} a rv:SemanticContext ; rv:contextRole ?role ;
        rv:contextState ?state ; rv:disclosure ?disclosure ; rv:semanticHead ?head . }
      ${revision ? `BIND(${iri(revision)} AS ?revision)` : 'BIND(?head AS ?revision)'}
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ContextSemanticRevision ; rv:component ${iri(context)} ;
        rv:manifest ?manifest . FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
    } LIMIT 2`;
  const selectedProfile = async () => {
    const digest = (await env.fuseki.commandHealth()).profiles['context-v1'];
    if (!digest) throw new ContextCommandUnavailable('Selected Context profile is unavailable');
    return digest;
  };
  const profile = await selectedProfile();
  const rows = (await env.fuseki.query(query, 16 * 1024)).results?.bindings ?? [];
  const token = readRowsToken(rows.map(({ sequence: _sequence, ...dependency }) => dependency));
  const row = rows[0];
  if (!row?.disclosure || (row.disclosure.value !== `${RV}Public` && !(row.disclosure.value === `${RV}Private`
    && await canReadPrivate(context)))) throw new ContextNotFound('Context is unavailable');
  if (rows.length !== 1 || !row.revision || !row.manifest || !row.head) {
    throw new ContextCommandUnavailable('Context read is incomplete');
  }
  const state = readComponentState(env.objectDirectory, row.manifest.value, context, CONTEXT_PROFILE);
  if (state.revision !== row.revision.value || !Array.isArray(state.entries)
    || typeof state.inheritanceDepth !== 'number' || typeof state.authoredBy !== 'string') {
    throw new ContextCommandUnavailable('Context revision payload differs from its anchor');
  }
  const after = (await env.fuseki.query(query, 16 * 1024)).results?.bindings ?? [];
  if (token !== readRowsToken(after.map(({ sequence: _sequence, ...dependency }) => dependency))
    || profile !== await selectedProfile()) throw new ContextCommandUnavailable('Context read basis changed');
  if (row.disclosure.value === `${RV}Private` && !await canReadPrivate(context)) {
    throw new ContextNotFound('Context is unavailable');
  }
  return { profile: 'context-v1', context,
    role: row.role?.value === `${RV}GlobalInterpretation` ? 'global-interpretation' : 'shared-interpretation',
    state: row.state?.value === `${RV}Retired` ? 'retired' : 'active',
    disclosure: row.disclosure.value === `${RV}Public` ? 'public' : 'private',
    semanticHead: row.head.value, revision: row.revision.value,
    predecessor: (state.predecessor as string | null) ?? null, base: (state.base as string | null) ?? null,
    inheritanceDepth: state.inheritanceDepth, entries: state.entries as ContextEntryRecord[],
    authoredBy: state.authoredBy,
    sourcePosition: { datasetId: 'product', dataEpoch: row.epoch!.value, sequence: row.sequence!.value,
      dependencyToken: readDependencyToken([profile, token]) } };
}
