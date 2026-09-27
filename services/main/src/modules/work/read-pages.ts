import type { Static } from 'typebox';
import { GRAPHS, iri, lit } from './activate.ts';
import { adoptionItem, creditItem, historyItem, versionItem } from './read-contract.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadUnavailable, type WorkReadSession } from './read-session.ts';
import { fenceWorkBasis, readWorkBasis } from './read-header.ts';

export type WorkPageKind = 'versions' | 'history' | 'adoptions' | 'credits';
type Version = Static<typeof versionItem>;
type History = Static<typeof historyItem>;
type Adoption = Static<typeof adoptionItem>;
type Credit = Static<typeof creditItem>;

/** Each query selects one page in storage, before hydration, without OFFSET. */
export async function readWorkPage(session: WorkReadSession, work: string, kind: WorkPageKind,
  filter: { language?: string; kind?: 'text-variant' | 'release' } = {}) {
  const basis = await readWorkBasis(session, work);
  const main = basis.card.mainVersion;
  const limit = session.options.limit ?? 20;
  const binding = [kind, work, session.options.language ?? null, session.options.actingSubject ?? null, filter];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const after = cursor ? `FILTER(STR(?id) > ${lit(cursor.after)})` : '';
  let relation: string;
  switch (kind) {
    case 'versions':
      relation = `{ GRAPH ${iri(GRAPHS.current)} {
          ?id a rv:TextContribution ; rv:work ${iri(work)} ; rv:publicationHead ?decision ; rv:language ?language . }
        GRAPH ${iri(GRAPHS.revisions)} { ?decision a rv:PublicationDecision ; rv:component ?id ;
          rv:work ${iri(work)} ; rv:contribution ?id ; rv:selectedDraft ?revision ;
          rv:language ?language ; rv:disclosure rv:Public ; rv:rightsBasis rv:OriginalContribution .
          ?revision a rv:RevisionAnchor ; rv:component ?id .
          FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
        BIND(?id AS ?contribution) BIND("text-variant" AS ?kind)
        BIND(EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(main)} rv:selectionHead ?selection }
          GRAPH ${iri(GRAPHS.revisions)} { ?selection rv:contribution ?id ; rv:publicationDecision ?decision } } AS ?selected)
      } UNION { GRAPH ${iri(GRAPHS.revisions)} {
          ?id a rv:FixedRelease ; rv:work ${iri(work)} ; rv:mainVersion ${iri(main)} ;
            rv:selectedDraft ?revision ; rv:contribution ?contribution ; rv:publicationDecision ?decision ; rv:language ?language .
          ?decision rv:disclosure rv:Public . FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
        GRAPH ${iri(GRAPHS.current)} { ?contribution rv:publicationHead ?decision }
        BIND("release" AS ?kind) BIND(false AS ?selected) }`;
      break;
    case 'history':
      // Immutable metadata revision identities only; exact bytes use the existing disclosure-aware read.
      relation = `GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:RevisionAnchor ; rv:component ${iri(work)} ;
        rv:modelRevision <https://rezics.com/definition/work-metadata-v1> ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ?id a rv:ErasedRevision } }`;
      break;
    case 'adoptions':
      relation = `GRAPH ${iri(GRAPHS.current)} {
        ?id a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
        ?space a rv:Space ; rv:realmCapability ?id ; rv:disclosure rv:Public .
        ?slot a rv:RealmPublicationSlot ; rv:realm ?id ; rv:mainVersion ${iri(main)} ; rv:selectionHead ?selection .
        ?contribution rv:publicationHead ?decision . }
        GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:PublicationSelection ; rv:work ${iri(work)} ;
          rv:contribution ?contribution ; rv:publicationDecision ?decision ; rv:language ?language ; rv:selectedDraft ?draft .
          ?decision rv:disclosure rv:Public . FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }`;
      break;
    case 'credits':
      relation = `GRAPH ${iri(GRAPHS.current)} { ?id a rv:AuthorCredit ; rv:work ${iri(work)} ;
        rv:creditRevision ?revision ; schema:roleName "author" ; rv:externalProvider "open-library" ;
        rv:externalNamespace "author" ; rv:externalKey ?key ; schema:position ?ordinal ; rv:editControl rv:HumanConfirmed . }
        GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:AuthorCreditRevision ; rv:component ?id ;
          rv:work ${iri(work)} ; rv:externalKey ?key ; schema:position ?ordinal . }`;
  }
  const rows = await session.query(`SELECT DISTINCT ?id ?kind ?language ?revision ?contribution ?selected
    ?epoch ?sequence ?selection ?key ?ordinal WHERE { { ${relation} } ${after}
    ${kind === 'versions' && filter.language ? `FILTER(LCASE(STR(?language)) = ${lit(filter.language.toLowerCase())})` : ''}
    ${kind === 'versions' && filter.kind ? `FILTER(?kind = ${lit(filter.kind)})` : ''}
  } ORDER BY STR(?id) LIMIT ${limit + 1}`, limit + 1);
  const page = rows.slice(0, limit);
  if (new Set(rows.map(row => row.id?.value)).size !== rows.length || page.some(row => !row.id)) {
    throw new WorkReadUnavailable('Page contains ambiguous identities');
  }
  const next = rows.length > limit ? encodeReadCursor(binding, session.position, page.at(-1)!.id!.value) : null;
  const field = (row: typeof rows[number], key: string) => {
    if (!row[key]) throw new WorkReadUnavailable('Page field is unavailable');
    return row[key]!.value;
  };
  const names = kind === 'adoptions' ? await session.summaries(page.map(row => row.id!.value)) : [];
  const items = page.flatMap<Version | History | Adoption | Credit>((row, index) => {
    const id = field(row, 'id');
    switch (kind) {
      case 'versions': return [{ id, kind: field(row, 'kind') as Version['kind'], language: field(row, 'language'),
        contribution: field(row, 'contribution'), revision: field(row, 'revision'), selected: row.selected?.value === 'true' }];
      case 'history': return [{ revision: id, sequence: field(row, 'sequence'), dataEpoch: field(row, 'epoch'),
        current: id === basis.card.revision, href: `/v1/revisions/${id.slice(-36)}` }];
      case 'credits': return [{ id, role: 'author' as const, participantKind: 'external-reference' as const,
        provider: 'open-library' as const, key: field(row, 'key'), ordinal: Number(field(row, 'ordinal')),
        agent: null, displayName: null, handle: null }];
      case 'adoptions': {
        const name = names[index];
        return name?.status === 'available' ? [{ realm: id, name: name.name,
          selection: field(row, 'selection'), contribution: field(row, 'contribution'), language: field(row, 'language') }] : [];
      }
    }
  });
  await fenceWorkBasis(session, basis);
  return pageResult(session, items, next);
}
