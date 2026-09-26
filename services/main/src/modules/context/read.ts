import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState } from '../work/history.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { ContextCommandUnavailable } from './command.ts';
import { CONTEXT_PROFILE, type ContextEntryRecord } from './schema.ts';

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
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

/**
 * Read one exact semantic revision (the head when `revision` is null). A Private Context the
 * caller cannot read is reported exactly like a missing one, so its identity does not leak.
 * The entries come from the sealed manifest; missing or corrupt bytes are unavailable.
 */
export async function readContextRevision(env: WorkActivationEnvironment, context: string,
  revision: string | null, canReadPrivate: (context: string) => Promise<boolean>): Promise<ContextRevisionRead> {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?role ?state ?disclosure
    ?head ?revision ?manifest WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      GRAPH ${iri(GRAPHS.current)} { ${iri(context)} a rv:SemanticContext ; rv:contextRole ?role ;
        rv:contextState ?state ; rv:disclosure ?disclosure ; rv:semanticHead ?head . }
      ${revision ? `BIND(${iri(revision)} AS ?revision)` : 'BIND(?head AS ?revision)'}
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ContextSemanticRevision ; rv:component ${iri(context)} ;
        rv:manifest ?manifest . }
    }`)).results?.bindings ?? [];
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
  return { profile: 'context-v1', context,
    role: row.role?.value === `${RV}GlobalInterpretation` ? 'global-interpretation' : 'shared-interpretation',
    state: row.state?.value === `${RV}Retired` ? 'retired' : 'active',
    disclosure: row.disclosure.value === `${RV}Public` ? 'public' : 'private',
    semanticHead: row.head.value, revision: row.revision.value,
    predecessor: (state.predecessor as string | null) ?? null, base: (state.base as string | null) ?? null,
    inheritanceDepth: state.inheritanceDepth, entries: state.entries as ContextEntryRecord[],
    authoredBy: state.authoredBy,
    sourcePosition: { datasetId: 'product', dataEpoch: row.epoch!.value, sequence: row.sequence!.value } };
}
