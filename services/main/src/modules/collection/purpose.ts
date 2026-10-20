import { readDefinitionByKey } from '../relation/change.ts';
import { readCurrentComponent } from '../semantic/change.ts';
import { readAdoptedSubjectProperty, requireCollectionStatementSubject } from '../statement/subject-read.ts';
import { checkedCollectionPurposeValue, COLLECTION_PURPOSE_NOTATION,
  type CollectionPurposeKind } from '../statement/qualification.ts';
import { readingBoundary } from '../reading-position/boundary.ts';
import { WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { languageScript, selectedProjection, type RelationRendering } from '../lexicon/render.ts';
import { selectDisplayName } from '../display-language/select.ts';
import { CompositionCorrupt } from '../structure/graph.ts';
import { RevisionCorrupt } from '../work/history.ts';
import { StatementBatchUnavailable } from '../statement/read.ts';

export interface CollectionPurpose {
  kind: CollectionPurposeKind;
  statement: string;
  revision: string;
  sources: string[];
}

/** Collection incidence is an existing Structure fact, not a fabricated native
 * relation Definition. The finite headings describe its adopted purpose only. */
export interface CollectionIncidenceRendering extends Omit<RelationRendering, 'meaning'> {
  meaning: null;
  structuralBasis: { profile: 'collection-membership'; collection: string; member: string };
}
// These fixed vocabulary labels carry their own language. Reader preferences
// select their presentation; they never supply a language for native data.
const incidenceLabels = {
  original: 'en',
  headings: {
    ordinary: 'Collections', 'reading-list': 'Reading lists', 'recipe-selection': 'Recipe selections',
    series: 'Series', franchise: 'Franchises',
  } satisfies Record<CollectionPurposeKind | 'ordinary', string>,
};
export function renderCollectionIncidence(collection: string, member: string,
  purpose: CollectionPurpose | null, languages: readonly string[]): CollectionIncidenceRendering {
  const bindings = [{ role: 'member', participant: { kind: 'resource' as const, ref: member } },
    { role: 'collection', participant: { kind: 'resource' as const, ref: collection } }];
  const projection = selectedProjection([], 'member', 'collection', languages, bindings);
  const heading = selectDisplayName({ original: incidenceLabels.original,
    labels: { [incidenceLabels.original]: incidenceLabels.headings[purpose?.kind ?? 'ordinary'] } }, languages)!;
  const script = languageScript(heading.language);
  const requestedScript = projection.fallback?.requestedScript ?? null;
  const crossedScript = !!requestedScript && !!script && requestedScript !== script;
  return { profile: 'relation-rendering-v1', meaning: null,
    structuralBasis: { profile: 'collection-membership', collection, member },
    occurrence: null, viewingRole: 'member', bindings, projections: [{ ...projection,
      labels: { noun: heading.value, heading: heading.value, plurals: { other: heading.value }, grammaticalForms: [] },
      language: heading.language, script, direction: heading.direction,
      fallback: languages[0] === heading.language ? null : { reason: crossedScript ? 'script-fallback' : 'language-fallback',
        requestedLanguages: [...languages], usedLanguage: heading.language,
        requestedScript, usedScript: script, crossedScript, conversion: null },
    }] };
}

/** Current Global adoption of the fixed property. A bounded subject/predicate
 * scan establishes absence; a preview or a wiki-supported proposal cannot.
 * Selection fences compare the disclosed result, so hidden assertions cannot
 * change a public count, ambiguity error or continuation. */
export async function readCollectionPurpose(session: WorkReadSession, collection: string): Promise<CollectionPurpose | null> {
  return session.selection(`collection-purpose:${collection}`, async probe => {
    const boundary = readingBoundary(probe);
    const requireCollection = () => requireCollectionStatementSubject(probe, collection);
    await requireCollection();
    const readable = async (resource: string) =>
      !!await probe.deps.access.canReadSemanticResource?.(probe.principal,
        probe.options.actingSubject ?? null, resource, undefined, probe.deps.environment.fuseki)
      && (await probe.disclosure([{ owner: 'graph', resource, component: 'record' }]))[0] === 'visible'
      && (await boundary.visible([resource])).has(resource);
    const definition = await readDefinitionByKey(probe.deps.environment, COLLECTION_PURPOSE_NOTATION,
      async references => new Set((await Promise.all(references.map(async ref => await readable(ref) ? ref : null)))
        .filter((ref): ref is string => ref !== null)), readable, ['property']);
    if (!definition) throw new WorkReadUnavailable('Collection purpose definition is unavailable');
    const current = await readCurrentComponent(probe.deps.environment, definition.definition, 'definition');
    if (!current || current.head !== definition.revision) throw new WorkReadMoved('Collection purpose definition changed');
    if (current.state.component !== 'definition' || current.state.kind !== 'property'
      || current.state.notation !== COLLECTION_PURPOSE_NOTATION || current.state.lifecycle !== 'active'
      || current.state.successor !== null || current.state.roles.length !== 0) {
      throw new WorkReadUnavailable('Collection purpose definition is unavailable');
    }
    const page = await readAdoptedSubjectProperty(probe, collection, definition.definition, requireCollection);
    const statements = page.groups.flatMap(group => group.items).filter(item => item.kind === 'statement');
    if (statements.length > 1 || page.nextCursor) throw new WorkReadUnavailable('Collection purpose is ambiguous');
    const statement = statements[0];
    if (!statement) return null;
    if (!statement.acceptance || statement.relationDefinition !== definition.revision
      || statement.predicate !== definition.definition || statement.qualifiers.applicability.length
      || statement.qualifiers.interpretationDefinitions.length || statement.qualifiers.qualification) {
      throw new WorkReadUnavailable('Collection purpose assertion meaning is unavailable');
    }
    let kind: CollectionPurposeKind;
    try { kind = checkedCollectionPurposeValue(statement.value); }
    catch { throw new WorkReadUnavailable('Collection purpose value is invalid'); }
    return { kind, statement: statement.statement, revision: statement.revision, sources: statement.sources };
  }).catch(error => {
    if (error instanceof RevisionCorrupt || error instanceof CompositionCorrupt || error instanceof StatementBatchUnavailable) {
      throw new WorkReadUnavailable('Collection purpose owner state is unavailable', { cause: error });
    }
    throw error;
  });
}
