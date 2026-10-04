import { zoneCards } from './cards.ts';
import { zoneAdoption } from './adoption.ts';
import { readEpochOrder } from '../discovery/lineage.ts';
import { namedDiscoveryCredits, primaryDiscoveryCredits } from '../discovery/credits.ts';
import type { DiscoveryCredit, ProjectedCredit } from '../discovery/contract.ts';
import { readAuthorNames } from '../source/author-name-read.ts';
import { readRealmDecisions } from '../realm-reads/public-decision-index.ts';
import { readRealmBasis } from '../realm-reads/read-realm.ts';
import { GRAPHS, WORK_SEMANTIC_TYPES, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, publicWork,
  WorkReadInvalid, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { readSerialSummaries } from '../work/summary-serial.ts';
import { readPublicHubCards } from '../hub/public-card.ts';
import { ZONE_MODULE_COST } from './contract.ts';

type Kind = 'new-adoptions' | 'recently-completed';

/** A placement label in the reader's language, else its base language, else the first; placeholders name nothing. */
export function chapterLabel(labels: readonly { value: string; language: string }[], language: string) {
  const wanted = language.toLowerCase();
  const label = labels.find(item => item.language.toLowerCase() === wanted)
    ?? labels.find(item => item.language.toLowerCase().split('-')[0] === wanted.split('-')[0]) ?? labels[0];
  return label && !/^(?:untitled chapter|未命名章节)$/iu.test(label.value.trim()) ? label : null;
}
function cursorOrder(value: string) {
  const parts = value.split(':');
  if (parts.length !== 2 || !parts.every(part => /^\d+$/.test(part))) {
    throw new WorkReadInvalid('Zone module cursor ordering is invalid');
  }
  return parts;
}

export function displayZoneCredits(credits: ProjectedCredit[],
  names: ReadonlyMap<string, { displayName: string; handle: string | null }>,
  sourceNames: Awaited<ReturnType<typeof readAuthorNames>> = new Map()): DiscoveryCredit[] {
  return credits.flatMap((credit): DiscoveryCredit[] => {
    if (credit.participantKind === 'external-reference') return [{ ...credit,
      displayName: null, nameSource: undefined, ...sourceNames.get(credit.key) }];
    const name = names.get(credit.agent);
    return name ? [{ ...credit, ...name }] : [];
  });
}

/** One retained-name batch of at most 60 credits per module page. */
export async function zoneCreditNames(session: WorkReadSession, credits: ProjectedCredit[]) {
  if (credits.length > ZONE_MODULE_COST.retainedAuthorKeys) {
    throw new WorkReadUnavailable('Zone credit batch is out of bounds');
  }
  const [agents, sources] = await Promise.all([
    namedDiscoveryCredits(session, credits),
    readAuthorNames(session, credits.flatMap(credit =>
      credit.participantKind === 'external-reference' ? [credit.key] : [])),
  ]);
  return { agents, sources };
}

/** One bounded candidate page, one type batch, two summary batches and ≤20 exact
 * metadata heads. Native graph sorting may scan D Realm decisions: O(D log D). */
export async function readZoneWorks(session: WorkReadSession, realm: string, kind: Kind) {
  await readRealmBasis(session, realm);
  const limit = session.options.limit ?? ZONE_MODULE_COST.pageSize;
  const binding = ['zone-module-v1', realm, kind, session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const order = cursor ? cursorOrder(cursor.order) : null;
  const epochs = await readEpochOrder(session);
  const status = kind === 'recently-completed';
  const rows = await session.query(`SELECT DISTINCT ?work ?head ?main ?evidence ?revisionEpoch
    ?sequence ?epochOrder WHERE {
    ${epochs}
    { ${zoneAdoption(realm)} }
    GRAPH ${iri(GRAPHS.current)} {
      ?work rv:head ?head .
      ${status ? '?work rv:completionStatus "completed" ; rv:descriptiveMetadataHead ?evidence .' : ''} }
    ${status ? '' : 'BIND(?selection AS ?evidence)'}
    GRAPH ${iri(GRAPHS.revisions)} {
      ?evidence ${status ? 'a rv:WorkMetadataRevision ;' : ''}
        rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence . }
    ${publicWork('?work', '?main')}


    ${order && cursor ? `FILTER(?epochOrder > ${order[0]} || (?epochOrder = ${order[0]}
      && (?sequence < ${order[1]} || (?sequence = ${order[1]}
        && STR(?evidence) > ${lit(cursor.after)}))))` : ''}
  } ORDER BY ?epochOrder DESC(?sequence) STR(?evidence) LIMIT ${limit + 1}`, limit + 1);
  if (rows.some(row => !row.work || !row.head || !row.main || !row.evidence
    || !row.revisionEpoch || !/^\d+$/.test(row.sequence?.value ?? '')
    || !/^\d+$/.test(row.epochOrder?.value ?? ''))
    || new Set(rows.map(row => row.work!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Zone Work candidates are ambiguous');
  }
  const page = rows.slice(0, limit), ids = page.map(row => row.work!.value);
  const summaries = await session.summaries(ids);
  const serial = await readSerialSummaries(session, ids.filter((id, index) =>
    summaries[index]?.status === 'available' && summaries[index]?.disclosure === 'public'
    && summaries[index]?.type === 'work'));
  const typeRows = ids.length ? await session.query(`SELECT ?work ?type WHERE {
    VALUES ?work { ${ids.map(iri).join(' ')} }
    VALUES ?type { ${WORK_SEMANTIC_TYPES.map(type => `<${type}>`).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a ?type }
  } LIMIT ${ZONE_MODULE_COST.typeRows + 1}`, ZONE_MODULE_COST.typeRows) : [];
  const fenced = await session.summaries(ids);
  const types = new Map<string, string[]>();
  for (const row of typeRows) {
    if (!row.work || !row.type || !ids.includes(row.work.value)) {
      throw new WorkReadUnavailable('Zone Work type relation is incomplete');
    }
    const list = types.get(row.work.value) ?? [];
    list.push(row.type.value);
    types.set(row.work.value, list);
  }
  const hydrated = await Promise.all(page.map(async (row, index) => {
    const summary = summaries[index], again = fenced[index], facts = serial.get(row.work!.value);
    if (summary?.status !== 'available' || summary.disclosure !== 'public'
      || again?.status !== 'available' || again.disclosure !== 'public') return null;
    if (!facts || status && facts.completionStatus !== 'completed') {
      throw new WorkReadUnavailable('Zone Work status differs from its metadata head');
    }
    return { id: row.work!.value, revision: row.head!.value, mainVersion: row.main!.value,
      title: summary.name, cover: summary.avatar, types: (types.get(row.work!.value) ?? []).sort(),
      ...facts, primaryCredits: await primaryDiscoveryCredits(session, row.work!.value),
      evidence: row.evidence!.value, dataEpoch: row.revisionEpoch!.value,
      sequence: row.sequence!.value };
  }));
  const visible = hydrated.filter((item): item is NonNullable<typeof item> => item !== null);
  const hub = session.deps.hub && session.deps.content
    ? await readPublicHubCards(session, visible.map(item => item.id)) : new Map();
  const names = await zoneCreditNames(session, visible.flatMap(item => item.primaryCredits));
  const items = await zoneCards(session, { realm }, visible.map(item => ({ ...item,
    primaryCredits: displayZoneCredits(item.primaryCredits, names.agents, names.sources),
    hub: hub.get(item.id) ?? null })));
  await readRealmBasis(session, realm);
  const last = page.at(-1);
  return { profile: status ? 'zone-recently-completed-v1' as const : 'zone-new-adoptions-v1' as const,
    realm, ...pageResult(session, items, rows.length > limit && last
      ? encodeReadCursor(binding, session.position, last.evidence!.value,
        `${last.epochOrder!.value}:${last.sequence!.value}`) : null) };
}

export async function readZoneDecisions(session: WorkReadSession, realm: string) {
  const page = await readRealmDecisions(session, realm);
  return { ...page, profile: 'zone-recent-decisions-v1' as const, realm,
    summary: { adoption: page.items.filter(item => item.kind === 'adoption').length,
      classification: page.items.filter(item => item.kind === 'classification').length,
      semanticRuleChange: page.items.filter(item => item.kind === 'semantic-rule-change').length,
      basis: 'exact-page' as const } };
}

/** Current public chapter publications only. The graph relation may scan D
 * placements and sort them O(D log D); hydration is bounded to one page, and
 * one label query and one Content receipt read name and date its chapters. */
export async function readZoneChapters(session: WorkReadSession, realm: string) {
  await readRealmBasis(session, realm);
  const limit = session.options.limit ?? ZONE_MODULE_COST.pageSize;
  const binding = ['zone-latest-chapters-v1', realm, session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const order = cursor ? cursorOrder(cursor.order) : null;
  const epochs = await readEpochOrder(session);
  const rows = await session.query(`SELECT DISTINCT ?work ?head ?main ?chapter ?placement ?publication
    ?contentRevision ?language ?revisionEpoch ?sequence ?epochOrder ?ownerEpoch ?ownerSequence WHERE {
    ${epochs}
    { ${zoneAdoption(realm)} }
    GRAPH ${iri(GRAPHS.current)} {
      ?work rv:head ?head .
      ?structure a rv:Structure ; rv:structureOf ?main ; rv:selectedGeneration ?generation .
      ?generation rv:generationState rv:Active .
      ?placement a rv:OccurrencePlacement ; rv:generation ?generation ;
        rv:occurrenceRole rv:ChapterRole ; schema:item ?chapter .
      FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
      ?variant a rv:ContentVariant ; rv:resource ?chapter ;
        rv:contentPublicationHead ?publication ; rv:publicSearchEligibilityHead ?eligibility . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?publication a rv:ContentPublicationDecision, rv:RevisionAnchor ;
        rv:resource ?chapter ; rv:component ?variant ; rv:contentRevision ?contentRevision ;
        rv:contentLanguage ?language ; rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence .
      OPTIONAL { ?publication rv:ownerDataEpoch ?ownerEpoch ; rv:ownerSequence ?ownerSequence }
      ?eligibility a rv:ContentSearchEligibilityDecision ;
        rv:publicationDecision ?publication ; rv:disclosure rv:Public .
      FILTER NOT EXISTS { ?contentRevision a rv:ErasedRevision } }
    ${publicWork('?work', '?main')}
    ${order && cursor ? `FILTER(?epochOrder > ${order[0]} || (?epochOrder = ${order[0]}
      && (?sequence < ${order[1]} || (?sequence = ${order[1]}
        && STR(?publication) > ${lit(cursor.after)}))))` : ''}
  } ORDER BY ?epochOrder DESC(?sequence) STR(?publication) LIMIT ${limit + 1}`, limit + 1);
  if (rows.some(row => !row.work || !row.head || !row.main || !row.chapter || !row.placement || !row.publication
    || !row.contentRevision || !row.language || !row.revisionEpoch
    || !/^\d+$/.test(row.sequence?.value ?? '') || !/^\d+$/.test(row.epochOrder?.value ?? ''))
    || new Set(rows.map(row => row.publication!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Zone chapter candidates are ambiguous');
  }
  const page = rows.slice(0, limit), ids = [...new Set(page.map(row => row.work!.value))];
  const summaries = await session.summaries(ids);
  const serial = await readSerialSummaries(session, ids.filter((id, index) =>
    summaries[index]?.status === 'available' && summaries[index]?.disclosure === 'public'
    && summaries[index]?.type === 'work'));
  const types = new Map<string, string[]>();
  const typeRows = ids.length ? await session.query(`SELECT ?work ?type WHERE {
    VALUES ?work { ${ids.map(iri).join(' ')} }
    VALUES ?type { ${WORK_SEMANTIC_TYPES.map(type => `<${type}>`).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a ?type }
  } LIMIT ${ZONE_MODULE_COST.typeRows + 1}`, ZONE_MODULE_COST.typeRows) : [];
  for (const row of typeRows) {
    if (!row.work || !row.type || !ids.includes(row.work.value)) {
      throw new WorkReadUnavailable('Zone chapter type relation is incomplete');
    }
    types.set(row.work.value, [...(types.get(row.work.value) ?? []), row.type.value]);
  }
  const fenced = await session.summaries(ids);
  const hydrated = await Promise.all(page.map(async row => {
    const index = ids.indexOf(row.work!.value), summary = summaries[index], again = fenced[index];
    if (summary?.status !== 'available' || summary.disclosure !== 'public'
      || again?.status !== 'available' || again.disclosure !== 'public') return null;
    const facts = serial.get(row.work!.value);
    if (!facts) throw new WorkReadUnavailable('Zone chapter Work metadata is incomplete');
    return { work: { id: row.work!.value, revision: row.head!.value, mainVersion: row.main!.value,
      title: summary.name, cover: summary.avatar, types: (types.get(row.work!.value) ?? []).sort(), ...facts,
      primaryCredits: await primaryDiscoveryCredits(session, row.work!.value) },
    chapter: row.chapter!.value, publication: row.publication!.value,
    contentRevision: row.contentRevision!.value, language: row.language!.value,
    dataEpoch: row.revisionEpoch!.value, sequence: row.sequence!.value };
  }));
  const visible = hydrated.filter((item): item is NonNullable<typeof item> => item !== null);
  const placements = [...new Set(page.map(row => row.placement!.value))];
  const owned = page.flatMap(row => row.ownerEpoch && row.ownerSequence
    ? [{ epoch: row.ownerEpoch.value, sequence: row.ownerSequence.value }] : []);
  const [names, labelRows, times] = await Promise.all([
    zoneCreditNames(session, visible.flatMap(item => item.work.primaryCredits)),
    placements.length ? session.query(`SELECT ?placement ?label WHERE {
      VALUES ?placement { ${placements.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?placement rv:occurrenceLabel ?label } }
      LIMIT ${ZONE_MODULE_COST.chapterLabelRows + 1}`, ZONE_MODULE_COST.chapterLabelRows) : [],
    session.deps.serialStats?.publicationTimes(owned) ?? new Map<string, string>()]);
  // A chapter is named as the Book's contents name it: its placement's label in the reader's language.
  const labels = new Map<string, { value: string; language: string }[]>();
  for (const row of labelRows) {
    if (!row.placement || !row.label?.['xml:lang']) throw new WorkReadUnavailable('Chapter label is incomplete');
    labels.set(row.placement.value, [...labels.get(row.placement.value) ?? [],
      { value: row.label.value, language: row.label['xml:lang'] }]);
  }
  const ofPublication = new Map(page.map(row => [row.publication!.value, row]));
  const cards = await zoneCards(session, { realm }, visible.map(item => item.work));
  const items = visible.map((item, index) => {
    const row = ofPublication.get(item.publication)!;
    const label = chapterLabel(labels.get(row.placement!.value) ?? [], item.language);
    return { ...item, work: { ...cards[index]!,
      primaryCredits: displayZoneCredits(item.work.primaryCredits, names.agents, names.sources) },
    chapterTitle: label ? { value: label.value, language: label.language, direction: 'ltr' as const,
      basis: label.language.toLowerCase() === item.language.toLowerCase() ? 'requested' as const : 'fallback' as const }
      : null,
    chapterUpdatedAt: row.ownerEpoch && row.ownerSequence
      ? times.get(`${row.ownerEpoch.value}:${row.ownerSequence.value}`) ?? null : null };
  });
  await readRealmBasis(session, realm);
  const last = page.at(-1);
  return { profile: 'zone-latest-chapters-v1' as const, realm,
    ...pageResult(session, items, rows.length > limit && last
      ? encodeReadCursor(binding, session.position, last.publication!.value,
        `${last.epochOrder!.value}:${last.sequence!.value}`) : null) };
}
