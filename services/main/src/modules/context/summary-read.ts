import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { readComponentState } from '../work/history.ts';
import { term } from './command.ts';
import { CONTEXT_LIMITS, CONTEXT_PROFILE } from './schema.ts';
import type { ContextLabelPreference } from './preferences.ts';

export interface ContextSummaryHead { disclosure: 'public' | 'private'; preferenceRevision: string | null }

/** The current Context heads and selected CTX07 labels in a bounded pair of graph reads. */
export async function readContextSummaryBatch(env: WorkActivationEnvironment,
  contexts: readonly string[], selectedContext: string | null,
  canReadPrivate: (contexts: readonly string[]) => Promise<ReadonlySet<string>>,
  onPrivateCheck: (count: number) => void): Promise<{ contexts: Map<string, ContextSummaryHead>;
    selectedNames: Map<string, Map<string, string>>; selectedContextDenied: boolean;
    graphQueries: number }> {
  const ids = [...new Set([...contexts, ...(selectedContext ? [selectedContext] : [])])];
  const admitted = new Map<string, ContextSummaryHead>();
  const names = new Map<string, Map<string, string>>();
  if (!ids.length) return { contexts: admitted, selectedNames: names,
    selectedContextDenied: false, graphQueries: 0 };
  if (ids.length > 65) throw new Error('Context summary batch exceeds its bound');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?hold ?context ?disclosure
    ?semanticHead ?semanticManifest ?preferenceHead ?preferenceManifest WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch .
        OPTIONAL { ${iri(DATASET)} rv:restoreHold ?hold } }
      VALUES ?context { ${ids.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?context a rv:SemanticContext ; rv:contextState rv:Active ;
        rv:disclosure ?disclosure ; rv:semanticHead ?semanticHead . }
      GRAPH ${iri(GRAPHS.revisions)} { ?semanticHead a rv:ContextSemanticRevision ;
        rv:component ?context ; rv:manifest ?semanticManifest . }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?context rv:preferenceHead ?preferenceHead }
        GRAPH ${iri(GRAPHS.revisions)} { ?preferenceHead a rv:ContextPreferenceRevision ;
          rv:component ?context ; rv:manifest ?preferenceManifest . } }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
    } LIMIT 66`);
  const rows = result.results?.bindings ?? [];
  if (rows.length > 65 || rows.some(row => row.hold)) throw new Error('Context summary read is unavailable');
  const privateContexts = [...new Set(rows.filter(row => row.disclosure?.value === `${RV}Private`)
    .map(row => row.context?.value).filter((value): value is string => Boolean(value)))];
  if (privateContexts.length) onPrivateCheck(privateContexts.length);
  const privateAdmitted = privateContexts.length ? await canReadPrivate(privateContexts) : new Set<string>();
  const selectedContextDenied = !!selectedContext && privateContexts.includes(selectedContext)
    && !privateAdmitted.has(selectedContext);
  let preferences: ContextLabelPreference[] = [];
  let selectedHead: string | null = null;
  for (const row of rows) {
    const context = row.context?.value;
    if (!context || !row.semanticHead || !row.semanticManifest) continue;
    const disclosure = row.disclosure?.value === `${RV}Public` ? 'public'
      : row.disclosure?.value === `${RV}Private` ? 'private' : null;
    if (!disclosure) continue;
    if (disclosure === 'private' && !privateAdmitted.has(context)) continue;
    const semantic = readComponentState(env.objectDirectory, row.semanticManifest.value, context, CONTEXT_PROFILE);
    if (semantic.revision !== row.semanticHead.value || !Array.isArray(semantic.entries)) continue;
    const preferenceRevision = row.preferenceHead?.value ?? null;
    admitted.set(context, { disclosure, preferenceRevision });
    if (context !== selectedContext || !preferenceRevision || !row.preferenceManifest) continue;
    const preference = readComponentState(env.objectDirectory, row.preferenceManifest.value,
      context, CONTEXT_PROFILE);
    if (preference.revision !== preferenceRevision || !Array.isArray(preference.labels)
      || preference.labels.length > CONTEXT_LIMITS.preferences) continue;
    preferences = preference.labels as ContextLabelPreference[];
    selectedHead = row.semanticHead.value;
  }
  if (!selectedHead || !preferences.length) return { contexts: admitted, selectedNames: names,
    selectedContextDenied, graphQueries: 1 };
  const targets = [...new Set(preferences.map(label => label.target))];
  const defined = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?target ?relation ?state ?depth WHERE {
    VALUES ?target { ${targets.map(term).join(' ')} }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(selectedHead)} rv:baseRevision* ?revision .
      ?revision a rv:ContextSemanticRevision ; rv:component ?owner ;
        rv:inheritanceDepth ?depth ; rv:entry ?entry .
      ?entry rv:entryTarget ?target ; rv:entryState ?state .
      OPTIONAL { ?entry rv:entryRelation ?relation } }
    GRAPH ${iri(GRAPHS.current)} { ?owner rv:disclosure ?ownerDisclosure }
    FILTER(?owner = ${iri(selectedContext!)} || ?ownerDisclosure = rv:Public)
  } LIMIT ${CONTEXT_LIMITS.entries * (CONTEXT_LIMITS.inheritanceDepth + 1) + 1}`);
  const entries = defined.results?.bindings ?? [];
  if (entries.length > CONTEXT_LIMITS.entries * (CONTEXT_LIMITS.inheritanceDepth + 1)) {
    throw new Error('Context summary dependency read exceeds its bound');
  }
  const selected = new Map<string, { target: string; depth: number; state: string }>();
  for (const row of entries) {
    if (!row.target || !row.depth || !row.state) continue;
    const depth = Number(row.depth.value);
    if (!Number.isInteger(depth) || depth < 0 || depth > CONTEXT_LIMITS.inheritanceDepth) continue;
    const key = `${row.target.value}\n${row.relation?.value ?? ''}`;
    const previous = selected.get(key);
    if (!previous || depth > previous.depth) selected.set(key, { target: row.target.value,
      depth, state: row.state.value });
    else if (depth === previous.depth) selected.delete(key);
  }
  const definedTargets = new Set([...selected.values()].filter(entry => entry.state === `${RV}Defined`)
    .map(entry => entry.target));
  for (const label of preferences) {
    if (!definedTargets.has(label.target) || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(label.language)
      || !label.label?.trim() || label.label.length > 256) continue;
    const byLanguage = names.get(label.target) ?? new Map<string, string>();
    byLanguage.set(label.language.toLowerCase(), label.label);
    names.set(label.target, byLanguage);
  }
  return { contexts: admitted, selectedNames: names, selectedContextDenied, graphQueries: 2 };
}
