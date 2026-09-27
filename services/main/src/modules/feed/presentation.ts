import { namedDiscoveryCredits } from '../discovery/credits.ts';
import { DISCOVERY_COST, type DiscoveryCredit, type ProjectedCredit } from '../discovery/contract.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { metadataComponent, METADATA_PROFILE } from '../work/metadata-schema.ts';
import { parsedMetadataState, selectedMetadata } from '../work/metadata-read.ts';
import { WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { FEED_COST } from './contract.ts';

export interface FeedWorkPresentation { authors: DiscoveryCredit[]; excerpt: string | null; language: string | null }

/** One metadata batch, one credit batch, one name batch and one preview batch
 * for the admitted Works. The final fence checks pointers and credit identity
 * without hydrating metadata states or preview bodies a second time. */
export async function feedWorkPresentations(session: WorkReadSession, works: readonly string[]) {
  const ids = [...new Set(works)];
  if (ids.length > FEED_COST.candidates) throw new WorkReadUnavailable('Feed Work presentation budget exceeded');
  const items = new Map<string, FeedWorkPresentation>();
  if (!ids.length) return { items, fence: async () => {} };
  const values = ids.map(iri).join(' ');
  const pointersQuery = `SELECT ?work ?head ?main ?selection WHERE {
    VALUES ?work { ${values} }
    GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork .
      OPTIONAL { ?work rv:descriptiveMetadataHead ?head }
      OPTIONAL { ?work rv:mainVersion ?main . ?main rv:selectionHead ?selection } }
  } LIMIT ${ids.length + 1}`;
  const pointers = await session.query(pointersQuery, ids.length + 1);
  const pointerSignature = (rows: typeof pointers) => {
    if (rows.length !== ids.length || new Set(rows.map(row => row.work?.value)).size !== ids.length
      || rows.some(row => !row.work || !ids.includes(row.work.value) || row.selection && !row.main)) {
      throw new WorkReadUnavailable('Feed Work pointers are ambiguous');
    }
    return rows.map(row => [row.work!.value, row.head?.value ?? null,
      row.main?.value ?? null, row.selection?.value ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  };
  const originalPointers = pointerSignature(pointers);
  const components = ids.map(work => [work, metadataComponent(work,
    { kind: 'header', originalTitle: null, localized: [] })] as const);
  const metadata = await session.query(`SELECT ?work ?state WHERE {
    VALUES (?work ?component) { ${components.map(([work, component]) => `(${iri(work)} ${iri(component)})`).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work rv:descriptiveMetadataHead ?head .
      ?component a rv:WorkMetadataComponent ; rv:metadataKind "header" ;
        rv:work ?work ; rv:metadataHead ?head }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:WorkMetadataRevision ; rv:component ?component ;
      rv:modelRevision ${iri(METADATA_PROFILE)} ; rv:shapeRevision ${iri(METADATA_PROFILE)} ;
      rv:metadataState ?state }
  } LIMIT ${ids.length + 1}`, ids.length + 1);
  const states = new Map(metadata.map(row => [row.work?.value, row.state?.value]));
  if (states.size !== metadata.length || metadata.some(row => !row.work || !row.state || !ids.includes(row.work.value))
    || pointers.some(row => !!row.head !== states.has(row.work!.value))) {
    throw new WorkReadUnavailable('Feed metadata heads are incomplete');
  }

  const creditQuery = `SELECT ?work ?id ?revision ?key ?ordinal ?agent WHERE {
    VALUES ?work { ${values} }
    { GRAPH ${iri(GRAPHS.current)} { ?id a rv:AuthorCredit ; rv:work ?work ;
        rv:creditRevision ?revision ; schema:roleName "author" ; rv:externalProvider "open-library" ;
        rv:externalNamespace "author" ; rv:externalKey ?key ; schema:position ?ordinal ; rv:editControl rv:HumanConfirmed . }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:AuthorCreditRevision ; rv:component ?id ;
        rv:work ?work ; rv:externalKey ?key ; schema:position ?ordinal .
        FILTER NOT EXISTS { ?revision a rv:ErasedRevision } } }
    UNION
    { GRAPH ${iri(GRAPHS.current)} { ?id a rv:NativeAgentCredit ; rv:work ?work ;
        rv:creditRevision ?revision ; rv:agent ?agent ; schema:roleName "author" . }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:NativeAgentCreditRevision ; rv:component ?id ;
        rv:work ?work ; rv:agent ?agent ; schema:roleName "author" .
        FILTER NOT EXISTS { ?revision a rv:ErasedRevision } } }
  } ORDER BY ?work ?ordinal STR(?id) LIMIT ${ids.length * 64 + 1}`;
  const creditRows = await session.query(creditQuery, ids.length * 64 + 1);
  const creditSignature = (rows: typeof creditRows) => {
    if (rows.length > ids.length * 64 || rows.some(row => !row.work || !ids.includes(row.work.value)
      || !row.id || !row.revision || (!row.agent && (!row.key || !/^\d+$/.test(row.ordinal?.value ?? '')
        || !Number.isSafeInteger(Number(row.ordinal?.value)))) || (row.agent && (row.key || row.ordinal)))
      || new Set(rows.map(row => row.id!.value)).size !== rows.length) {
      throw new WorkReadUnavailable('Feed credits are ambiguous');
    }
    return rows.map(row => [row.work!.value, row.id!.value, row.revision!.value, row.key?.value ?? null,
      row.ordinal?.value ?? null, row.agent?.value ?? null]);
  };
  const originalCredits = creditSignature(creditRows);
  const credits = new Map<string, ProjectedCredit[]>(ids.map(work => [work, []]));
  for (const row of creditRows) {
    const selected = credits.get(row.work!.value)!;
    if (selected.length >= DISCOVERY_COST.primaryCredits) continue;
    selected.push(row.agent ? { id: row.id!.value, role: 'author', participantKind: 'agent',
      provider: null, key: null, ordinal: null, agent: row.agent.value, displayName: null, handle: null }
      : { id: row.id!.value, role: 'author', participantKind: 'external-reference',
        provider: 'open-library', key: row.key!.value, ordinal: Number(row.ordinal!.value),
        agent: null, displayName: null, handle: null });
  }
  const names = await namedDiscoveryCredits(session, [...credits.values()].flat(), ids.length);
  const excerpts = new Map<string, { excerpt: string | null; language: string | null }>();
  for (const work of ids) {
    const raw = states.get(work);
    const state = raw ? parsedMetadataState(raw) : { kind: 'header' as const, originalTitle: null, localized: [] };
    if (state.kind !== 'header') throw new WorkReadUnavailable('Feed metadata head has the wrong kind');
    const selected = selectedMetadata(state, session.options.language);
    const value = selected.tagline ?? selected.description;
    excerpts.set(work, { excerpt: value?.value.slice(0, 400) ?? null, language: value?.language ?? null });
  }
  const missing = ids.filter(work => !excerpts.get(work)?.excerpt);
  if (missing.length) {
    const bodies = await session.query(`SELECT ?work ?language (SUBSTR(STR(?body), 1, 400) AS ?preview) WHERE {
      VALUES ?work { ${missing.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?work rv:mainVersion ?main . ?main rv:selectionHead ?selection .
        ?contribution rv:publicationHead ?decision . }
      GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:PublicationSelection ; rv:mainVersion ?main ;
        rv:contribution ?contribution ; rv:publicationDecision ?decision ; rv:selectedDraft ?draft ; rv:language ?language .
        ?decision rv:disclosure rv:Public ; rv:selectedDraft ?draft .
        FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:selection ?selection ; rv:revision ?draft ; rv:searchBody ?body }
    } ORDER BY ?work ?language LIMIT ${missing.length * 64 + 1}`, missing.length * 64 + 1);
    const grouped = new Map<string, typeof bodies>();
    for (const row of bodies) {
      if (!row.work || !missing.includes(row.work.value) || !row.language || !row.preview) {
        throw new WorkReadUnavailable('Feed Main preview is ambiguous');
      }
      const group = grouped.get(row.work.value) ?? [];
      group.push(row); grouped.set(row.work.value, group);
      if (group.length > 64) throw new WorkReadUnavailable('Feed Main preview exceeds language bound');
    }
    if (bodies.length > missing.length * 64) throw new WorkReadUnavailable('Feed Main preview exceeds language bound');
    for (const [work, group] of grouped) {
      const preferred = group.find(row => row.language!.value.toLowerCase() === session.options.language?.toLowerCase())
        ?? group.find(row => row.language!.value === 'en') ?? group[0]!;
      excerpts.set(work, { excerpt: preferred.preview!.value, language: preferred.language!.value });
    }
  }
  for (const work of ids) {
    const authors = (credits.get(work) ?? []).flatMap(credit => {
      if (!credit.agent) return [credit as DiscoveryCredit];
      const name = names.get(credit.agent);
      return name ? [{ ...credit, ...name } as DiscoveryCredit] : [];
    });
    items.set(work, { authors, ...excerpts.get(work)! });
  }
  return { items, fence: async () => {
    if (JSON.stringify(pointerSignature(await session.query(pointersQuery, ids.length + 1)))
      !== JSON.stringify(originalPointers)
      || JSON.stringify(creditSignature(await session.query(creditQuery, ids.length * 64 + 1)))
      !== JSON.stringify(originalCredits)) throw new WorkReadMoved('Feed Work presentation changed');
    const currentNames = await namedDiscoveryCredits(session, [...credits.values()].flat(), ids.length);
    if (JSON.stringify([...currentNames]) !== JSON.stringify([...names])) throw new WorkReadMoved('Feed Work author changed');
  } };
}
