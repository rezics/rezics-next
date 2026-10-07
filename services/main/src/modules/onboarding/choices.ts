import { choiceWorkTypeOptions } from '../types/registry.ts';
import type { Static } from 'typebox';
import { VOCABULARY_PROFILE } from '../classification/vocabulary.ts';
import { CLASSIFIED_AS } from '../statement/schema.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { publicWork } from '../work/public-patterns.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { CHOICES_COST, type choiceConcept, contentLanguages, type OnboardingChoices } from './contract.ts';
import { readOnboardingClassifications } from './classifications.ts';

/**
 * The type a Work is grouped under when it has several: the most specific
 * first, so a mod is a mod before it is software and a web novel a book.
 */
export const choiceTypes = choiceWorkTypeOptions;

export const primaryType = (types: readonly string[]) => choiceTypes.find(type => types.includes(type)) ?? null;

/** Languages to offer, the reader's locale (or its script's tag) first. */
export function offeredLanguages(locale: string | undefined): string[] {
  const first = contentLanguages.find(language => language.toLowerCase() === locale?.toLowerCase())
    ?? contentLanguages.find(language => language.split('-')[0] === locale?.split('-')[0]);
  return first ? [first, ...contentLanguages.filter(language => language !== first)] : [...contentLanguages];
}

interface Sampled { concept: string; broader: string | null; order: number;
  works: Map<string, string | null> }

/**
 * Pick the Concepts to show and group them by their sample Works' type. A
 * Concept with most sample Works leads; ties keep scheme order, in which a
 * broader Concept precedes its narrower ones. Pure over its input.
 */
export function groupChoices(concepts: readonly Sampled[]) {
  const shown = concepts.filter(item => item.works.size).sort((a, b) => b.works.size - a.works.size || a.order - b.order)
    .slice(0, CHOICES_COST.shownConcepts).sort((a, b) => a.order - b.order);
  const groups = new Map<string, { concept: Sampled; works: string[] }[]>();
  for (const concept of shown) {
    for (const [work, type] of concept.works) {
      if (!type) continue;
      const members = groups.get(type) ?? [];
      const member = members.find(item => item.concept === concept);
      if (member) member.works.push(work); else members.push({ concept, works: [work] });
      groups.set(type, members);
    }
  }
  return [...groups].sort((a, b) => b[1].length - a[1].length
    || choiceTypes.indexOf(a[0] as typeof choiceTypes[number]) - choiceTypes.indexOf(b[0] as typeof choiceTypes[number]))
    .slice(0, CHOICES_COST.groups)
    .map(([type, members]) => ({ type, members: members.slice(0, CHOICES_COST.groupConcepts)
      .map(member => ({ concept: member.concept, works: member.works.slice(0, CHOICES_COST.shownSamples) })) }));
}

/** `GET /v1/onboarding/choices`: languages, then the shared scheme's Concepts by type with example covers. */
export async function readChoices(session: WorkReadSession): Promise<OnboardingChoices> {
  const scheme = await session.query(`SELECT ?concept ?broader WHERE { GRAPH ${iri(GRAPHS.current)} {
    ?concept a skos:Concept ; rv:definitionProfile ${iri(VOCABULARY_PROFILE)} ; rv:conceptState rv:Active ;
      skos:inScheme ?scheme .
    ?scheme a skos:ConceptScheme ; rv:schemeState rv:Active .
    FILTER NOT EXISTS { ?concept rv:conceptState rv:Retired }
    FILTER NOT EXISTS { ?concept rv:protectionHead ?protection }
    FILTER NOT EXISTS { ?concept rv:conceptRealm ?realm }
    OPTIONAL { ?concept skos:broader ?broader . ?broader skos:inScheme ?scheme }
  } } ORDER BY STR(?concept) STR(?broader) LIMIT ${CHOICES_COST.schemeConcepts * 2}`, CHOICES_COST.schemeConcepts * 2);
  const concepts = new Map<string, Sampled>();
  for (const row of scheme) {
    const concept = row.concept!.value;
    if (!concepts.has(concept) && concepts.size < CHOICES_COST.schemeConcepts) {
      concepts.set(concept, { concept, broader: row.broader?.value ?? null, order: concepts.size, works: new Map() });
    }
  }
  if (concepts.size) {
    // Discover bounded samples; the classification read owns acceptance and disclosure.
    const branch = (concept: string, after: string | null) => `{ SELECT DISTINCT ?concept ?work ?main WHERE {
      BIND(${iri(concept)} AS ?concept)
      GRAPH ${iri(GRAPHS.current)} {
        ?statement rdf:subject ?main ; rdf:predicate <${CLASSIFIED_AS}> ; rdf:object ${iri(concept)} . }
      ${publicWork('?work', '?main')}
      ${after ? `FILTER(STR(?work) > ${lit(after)})` : ''}
    } ORDER BY STR(?work) LIMIT ${CHOICES_COST.samplesPerConcept + 1} }`;
    const disclosed = new Map<string, Set<string>>();
    const types = new Map<string, string[]>();
    let pending = new Map([...concepts.keys()].map(concept => [concept, null as string | null]));
    while (pending.size) {
      const limit = pending.size * (CHOICES_COST.samplesPerConcept + 1) * CHOICES_COST.workTypes;
      const rows = await session.query(`SELECT ?concept ?work ?main ?type WHERE {
        ${[...pending].map(([concept, after]) => branch(concept, after)).join(' UNION ')}
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?work a ?type }
          VALUES ?type { ${choiceTypes.map(type => `<${type}>`).join(' ')} } }
      }`, limit);
      const candidates = new Map([...pending.keys()].map(concept => [concept, new Map<string, string>()]));
      for (const row of rows) {
        const work = row.work?.value, concept = row.concept?.value, main = row.main?.value;
        const own = candidates.get(concept ?? '');
        if (!work || !concept || !main || !own || own.has(work) && own.get(work) !== main) {
          throw new WorkReadUnavailable('Concept samples are ambiguous');
        }
        own.set(work, main);
        types.set(work, [...types.get(work) ?? [], ...row.type ? [row.type.value] : []]);
      }
      const pages = new Map([...candidates].map(([concept, works]) => [concept,
        [...works].sort(([a], [b]) => a.localeCompare(b))]));
      const targets = [...pages.values()].flatMap(page => page.slice(0, CHOICES_COST.samplesPerConcept)
        .filter(([work]) => !disclosed.has(work)).map(([work, mainVersion]) => ({ work, mainVersion })));
      for (const [work, visible] of await readOnboardingClassifications(session, targets)) disclosed.set(work, visible);
      const next = new Map<string, string | null>();
      for (const [concept, page] of pages) {
        const entry = concepts.get(concept)!;
        for (const [work] of page.slice(0, CHOICES_COST.samplesPerConcept)) {
          if (disclosed.get(work)?.has(concept) && entry.works.size < CHOICES_COST.samplesPerConcept) {
            entry.works.set(work, null);
          }
        }
        if (entry.works.size < CHOICES_COST.samplesPerConcept && page.length > CHOICES_COST.samplesPerConcept) {
          next.set(concept, page[CHOICES_COST.samplesPerConcept - 1]![0]);
        }
      }
      pending = next;
    }
    for (const entry of concepts.values()) {
      for (const work of entry.works.keys()) entry.works.set(work, primaryType(types.get(work) ?? []));
    }
  }
  const grouped = groupChoices([...concepts.values()]);
  const conceptIds = [...new Set(grouped.flatMap(group => group.members.map(member => member.concept.concept)))];
  const workIds = [...new Set(grouped.flatMap(group => group.members.flatMap(member => member.works)))]
    .slice(0, CHOICES_COST.sampleWorks);
  const [conceptNames, workNames] = await Promise.all([session.summaries(conceptIds), session.summaries(workIds)]);
  const named = new Map([...conceptNames, ...workNames].map(summary => [summary.reference, summary]));
  const shown = new Set(conceptIds);
  const groups = grouped.map(group => ({ type: group.type, concepts: group.members.flatMap(member => {
    const summary = named.get(member.concept.concept);
    if (summary?.status !== 'available' || summary.type !== 'concept') return [];
    const samples = member.works.flatMap(work => {
      const card = named.get(work);
      return card?.status === 'available' && card.type === 'work' && card.disclosure === 'public'
        ? [{ id: work, title: card.name, cover: card.avatar }] : [];
    });
    if (!samples.length) return [];
    const broader = member.concept.broader && shown.has(member.concept.broader) ? member.concept.broader : null;
    const choice: Static<typeof choiceConcept> = { id: member.concept.concept, name: summary.name, broader, samples };
    return [choice];
  }) })).filter(group => group.concepts.length);
  return { profile: 'onboarding-choices-v1', languages: offeredLanguages(session.options.language), groups,
    sourcePosition: session.position };
}
