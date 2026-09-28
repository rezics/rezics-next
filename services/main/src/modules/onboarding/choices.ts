import type { Static } from 'typebox';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { VOCABULARY_PROFILE } from '../classification/vocabulary.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { publicWork } from '../work/public-patterns.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { CHOICES_COST, type choiceConcept, contentLanguages, type OnboardingChoices } from './contract.ts';

/**
 * The type a Work is grouped under when it has several: the most specific
 * first, so a mod is a mod before it is software and a web novel a book.
 */
export const choiceTypes = [
  'https://rezics.com/vocab/ModPackage', 'https://rezics.com/vocab/SkillPackage',
  'https://rezics.com/vocab/PromptTemplate', 'https://schema.org/Recipe', 'https://schema.org/VideoGame',
  'https://schema.org/Book', 'https://schema.org/BookSeries', 'https://schema.org/SoftwareApplication',
  'https://schema.org/SoftwareSourceCode', 'https://schema.org/Movie', 'https://schema.org/TVSeries',
  'https://schema.org/VideoObject', 'https://schema.org/MusicAlbum', 'https://schema.org/MusicRecording',
  'https://schema.org/AudioObject', 'https://schema.org/DigitalDocument',
] as const;

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
    // Each Concept reads at most four accepted, public Works; their types come with them.
    const branch = (concept: string) => `{ SELECT ?concept ?work WHERE {
      BIND(${iri(concept)} AS ?concept)
      GRAPH ${iri(GRAPHS.current)} {
        ?expression rv:assertedConcept ${iri(concept)} ; rv:expressionState rv:Active .
        ?sense a rv:ClassificationSense ; rv:senseState rv:Active ; rv:expression ?expression .
        ?application a rv:ClassificationApplication ; rv:sense ?sense ; rv:targetMainVersion ?main ;
          rv:classificationContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:applicationState rv:Active ;
          rv:decisionHead ?decision .
        ?main rv:work ?work . }
      GRAPH ${iri(GRAPHS.revisions)} { ?decision rv:outcome rv:Accepted . }
      ${publicWork('?work', '?main')}
    } LIMIT ${CHOICES_COST.samplesPerConcept} }`;
    const limit = concepts.size * CHOICES_COST.samplesPerConcept * CHOICES_COST.workTypes;
    const rows = await session.query(`SELECT ?concept ?work ?type WHERE {
      ${[...concepts.keys()].map(branch).join(' UNION ')}
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?work a ?type }
        VALUES ?type { ${choiceTypes.map(type => `<${type}>`).join(' ')} } }
    }`, limit);
    const types = new Map<string, string[]>();
    for (const row of rows) {
      const work = row.work?.value, concept = row.concept?.value;
      if (!work || !concept || !concepts.has(concept)) throw new WorkReadUnavailable('Concept samples are ambiguous');
      types.set(work, [...types.get(work) ?? [], ...row.type ? [row.type.value] : []]);
      concepts.get(concept)!.works.set(work, null);
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
