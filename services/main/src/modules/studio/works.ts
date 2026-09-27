import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadLimit, WorkReadMoved,
  WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { FALLBACK_POLICY } from '../media/summary.ts';

export const STUDIO_WORK_COST = { pageSize: 20, textsPerPage: 200,
  submissionsPerPage: 200, graphCalls: 5, accessCalls: 4 } as const;
const types = ['https://schema.org/Book', 'https://schema.org/DigitalDocument',
  'https://schema.org/Recipe'] as const;
type WorkType = typeof types[number];
export interface StudioWorkFilters { state?: 'draft' | 'published' | 'empty'; type?: WorkType }

/** Agent control is fenced before and after this bounded cross-owner read. */
export async function readStudioWorks(session: WorkReadSession, agent: string,
  filters: StudioWorkFilters) {
  const principal = session.principal;
  const access = session.deps.studioAccess;
  if (!principal || !access || session.options.actingSubject !== agent) {
    throw new WorkReadUnavailable('Studio authority is unavailable');
  }
  const limit = session.options.limit ?? 20;
  const first = await access.studioWorks(principal, agent,
    '00000000-0000-0000-0000-000000000000', 1);
  const binding = ['studio-works-v1', agent, filters.state ?? null, filters.type ?? null, first.stamp];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const after = cursor?.after ?? '00000000-0000-0000-0000-000000000000';
  const page = await access.studioWorks(principal, agent, after, limit + 1);
  if (page.stamp !== first.stamp) throw new WorkReadMoved('Studio controller changed');
  const admissions = page.rows.slice(0, limit);
  const byAdmission = new Map(admissions.map(row => [row.id, row]));
  const createAdmissions = admissions.filter(row => row.action === 'work.create');
  const chapterAdmissions = admissions.filter(row => row.action === 'work.edit');
  const workRows = createAdmissions.length ? await session.query(`SELECT ?admission ?work ?main ?head ?mainHead ?title
    ?disclosure WHERE {
      VALUES ?admission { ${createAdmissions.map(row => lit(row.id)).join(' ')} }
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ; rv:admissionId ?admission ;
        rv:outcome rv:Succeeded ; rv:work ?work ; rv:mainVersion ?main .
      }
      GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork ; rv:head ?head ;
        rv:mainVersion ?main ; rdfs:label ?title .
        ?main a rv:MainVersion ; rv:head ?mainHead ; rv:work ?work .
        OPTIONAL { ?work rv:disclosure ?disclosure }
        FILTER NOT EXISTS { ?work rv:protectionHead ?protection }
      }
    } LIMIT ${limit + 1}`, limit + 1) : [];
  const chapterRows = chapterAdmissions.length ? await session.query(`SELECT ?admission ?work ?main
    ?head ?mainHead ?title ?disclosure WHERE {
      VALUES ?admission { ${chapterAdmissions.map(row => lit(row.id)).join(' ')} }
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ; rv:admissionId ?admission ;
        rv:outcome rv:Succeeded ; rv:chapterWork ?work ; rv:chapterMainVersion ?main . }
      GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork ; rv:head ?head ;
        rv:mainVersion ?main ; rdfs:label ?title .
        ?main a rv:MainVersion ; rv:head ?mainHead ; rv:work ?work .
        OPTIONAL { ?work rv:disclosure ?disclosure }
        FILTER NOT EXISTS { ?work rv:protectionHead ?protection }
      }
    } LIMIT ${limit + 1}`, limit + 1) : [];
  workRows.push(...chapterRows);
  const order = new Map(admissions.map((row, index) => [row.id, index]));
  workRows.sort((left, right) => (order.get(left.admission?.value ?? '') ?? limit)
    - (order.get(right.admission?.value ?? '') ?? limit));
  if (new Set(workRows.map(row => row.admission?.value)).size !== workRows.length) {
    throw new WorkReadUnavailable('Studio Work receipt is ambiguous');
  }
  const workIds = workRows.map(row => row.work?.value).filter((value): value is string => !!value);
  const typeRows = workIds.length ? await session.query(`SELECT ?work ?type WHERE {
    VALUES ?work { ${workIds.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a ?type .
      FILTER(?type IN (${types.map(type => `<${type}>`).join(', ')})) }
  } LIMIT ${limit * types.length + 1}`, limit * types.length + 1) : [];
  const typeMap = new Map<string, string[]>();
  for (const row of typeRows) {
    if (!row.work || !row.type) throw new WorkReadUnavailable('Work type is incomplete');
    typeMap.set(row.work.value, [...typeMap.get(row.work.value) ?? [], row.type.value]);
  }
  const textRows = workIds.length ? await session.query(`SELECT ?work ?contribution ?language ?draft
    ?publication ?selected WHERE {
    VALUES ?work { ${workIds.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?contribution a rv:TextContribution ; rv:work ?work ;
      rv:author ${iri(agent)} ; rv:language ?language ; rv:draftHead ?draft .
      OPTIONAL { ?contribution rv:publicationHead ?publication }
    }
    OPTIONAL { FILTER(BOUND(?publication)) GRAPH ${iri(GRAPHS.revisions)} {
      ?publication rv:selectedDraft ?selected . } }
  } LIMIT ${STUDIO_WORK_COST.textsPerPage + 1}`, STUDIO_WORK_COST.textsPerPage + 1) : [];
  if (textRows.length > STUDIO_WORK_COST.textsPerPage) {
    throw new WorkReadLimit('Studio texts exceed page budget');
  }
  const texts = new Map<string, Array<{ contribution: string; language: string;
    draftHead: string; publicationHead: string | null; publicationDraft: string | null }>>();
  for (const row of textRows) {
    if (!row.work || !row.contribution || !row.language || !row.draft) {
      throw new WorkReadUnavailable('Studio text is incomplete');
    }
    texts.set(row.work.value, [...texts.get(row.work.value) ?? [], {
      contribution: row.contribution.value, language: row.language.value,
      draftHead: row.draft.value, publicationHead: row.publication?.value ?? null,
      publicationDraft: row.selected?.value ?? null }]);
  }
  const details = await access.studioWorkDetails(principal, agent, workIds);
  const editTimes = new Map(details.edits.map(row => [row.work, row.updated_at]));
  const summary = await session.summaries(workIds);
  const covers = new Map(summary.map(item => [item.reference, item]));
  const items = workRows.flatMap(row => {
    const admission = byAdmission.get(row.admission?.value ?? '');
    if (!admission || !row.work || !row.main || !row.head || !row.mainHead || !row.title) {
      throw new WorkReadUnavailable('Studio Work is incomplete');
    }
    const work = row.work.value;
    const ownTexts = texts.get(work) ?? [];
    const workTypes = typeMap.get(work) ?? [];
    if (filters.type && !workTypes.includes(filters.type)) return [];
    const state = ownTexts.some(text => text.publicationHead) ? 'published'
      : ownTexts.length ? 'draft' : 'empty';
    if (filters.state && state !== filters.state) return [];
    const cover = covers.get(work);
    const createdAt = admission.created_at.toISOString();
    const updatedAt = new Date(Math.max(admission.created_at.valueOf(),
      editTimes.get(work)?.valueOf() ?? 0)).toISOString();
    const language = row.title['xml:lang'] ?? 'en';
    return [{ id: work, mainVersion: row.main.value, workRevision: row.head.value,
      mainRevision: row.mainHead.value, title: { value: row.title.value, language },
      cover: cover?.status === 'available' ? cover.avatar : { kind: 'fallback' as const,
        policy: FALLBACK_POLICY, key: work, resourceType: 'work' as const },
      types: workTypes, disclosure: row.disclosure?.value === `${RV}Public` ? 'public' as const
        : 'restricted' as const, state, texts: ownTexts,
      submissions: details.submissions.filter(item => item.work === work).map(item => ({
        id: item.id, realm: item.realm, state: item.state,
        openedAt: item.opened_at.toISOString(), updatedAt: item.updated_at.toISOString() })),
      createdAt, updatedAt }];
  });
  const again = await access.studioWorks(principal, agent, after, limit + 1);
  if (again.stamp !== page.stamp || JSON.stringify(again.rows) !== JSON.stringify(page.rows)) {
    throw new WorkReadMoved('Studio Work inventory changed');
  }
  const tail = admissions.at(-1);
  return pageResult(session, items, page.rows.length > limit && tail
    ? encodeReadCursor(binding, session.position, tail.id) : null);
}
