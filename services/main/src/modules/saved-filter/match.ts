import type { FilterDocument } from '../../../../../model/definitions/filter-document-v1.ts';
import { compileQuery, QueryRejected } from '../query/compile.ts';
import { resourceConditions } from '../query/resources.ts';
import { resolveConcepts } from '../concept-page/read.ts';
import { languageSatisfies } from '../display-language/select.ts';
import { readWorkClassifications } from '../work/read-classifications.ts';
import { iri } from '../work/activate.ts';
import type { WorkReadSession } from '../work/read-session.ts';
import { homeFeedConditions } from './feed.ts';

export const SAVED_VIEW_MATCH_COST = { concepts: 3, interpretationsPerConcept: 4,
  sensesPerRead: 3, classificationReads: 4 } as const;

export interface SavedViewSubject {
  kind: 'work' | 'post'; ref: string; work: string; target: string;
  actor: string | null; realm: string | null; language: string | null;
}

/** Compile before reading. Resource Conditions retain G-939's meaning; posts
 * retain the Home tab's content-language and publishing-Realm Conditions. */
export function savedViewPlan(document: FilterDocument, kind: SavedViewSubject['kind']) {
  if (kind === 'post') {
    const home = homeFeedConditions(document);
    return { concepts: [...new Set([...home.concepts, ...home.requiredConcept ? [home.requiredConcept] : [],
      ...home.excludedConcepts ?? []])], home, conditions: null };
  }
  const compiled = compileQuery({ profile: 'resource-list-v1', context: 'global',
    scope: { kind: 'all' }, sort: 'newest', filter: document });
  if (compiled.template !== 'resource-list') throw new QueryRejected('unsupported_query_shape', 'Saved view has no resource template');
  const concepts = [...new Set(compiled.request.conditions.filter(row => row.facet === 'concept').flatMap(row => row.values))];
  if (concepts.length > SAVED_VIEW_MATCH_COST.concepts) {
    throw new QueryRejected('query_budget_exceeded', 'Saved view notification exceeds its Concept budget');
  }
  return { concepts, conditions: compiled.request.conditions, home: null };
}

/** Every Condition is evaluated, including required/excluded Concepts. */
export function savedViewConditionsMatch(plan: ReturnType<typeof savedViewPlan>,
  matchedConcepts: ReadonlySet<string>, subject: Pick<SavedViewSubject, 'language' | 'realm'>) {
  if (plan.home) {
    const home = plan.home;
    return (!home.concepts.length || home.concepts.some(value => matchedConcepts.has(value)))
      && (!home.requiredConcept || matchedConcepts.has(home.requiredConcept))
      && !home.excludedConcepts?.some(value => matchedConcepts.has(value))
      && (!home.languages.length || languageSatisfies(subject.language, home.languages))
      && (!home.realms.length || !!subject.realm && home.realms.includes(subject.realm));
  }
  return plan.conditions!.filter(row => row.facet === 'concept').every(row => {
    const flags = row.values.map(value => matchedConcepts.has(value));
    return row.operator === 'all' ? flags.every(Boolean) : row.operator === 'none' ? !flags.some(Boolean) : flags.some(Boolean);
  });
}

/** Exact subject selection, never the first page of a catalogue search. Current
 * owner reads avoid losing a new match while Discovery's projection catches up. */
export async function matchesSavedView(session: WorkReadSession, document: FilterDocument, subject: SavedViewSubject) {
  const plan = savedViewPlan(document, subject.kind);
  if (plan.conditions) {
    const rows = await session.query(`SELECT ?r WHERE { VALUES ?r { ${iri(subject.work)} }
      BIND(?r AS ?nameResource) ${resourceConditions(plan.conditions)} } LIMIT 2`, 1);
    if (!rows.length) return false;
  }
  const concepts: Awaited<ReturnType<typeof resolveConcepts>> = plan.concepts.length
    ? await resolveConcepts(session, plan.concepts) : new Map();
  // An invisible Condition cannot become a match through an exclusion.
  if (concepts.size !== plan.concepts.length) return false;
  const senses = [...new Set([...concepts.values()].flatMap(row => row.interpretations))];
  const accepted = new Set<string>();
  for (let offset = 0; offset < senses.length; offset += SAVED_VIEW_MATCH_COST.sensesPerRead) {
    const tags = await readWorkClassifications(session, subject.work,
      senses.slice(offset, offset + SAVED_VIEW_MATCH_COST.sensesPerRead));
    for (const tag of tags.items) accepted.add(tag.sense);
  }
  const matched = new Set<string>([...concepts].filter(([, value]) =>
    value.interpretations.some(sense => accepted.has(sense))).map(([concept]) => concept));
  return savedViewConditionsMatch(plan, matched, subject);
}
