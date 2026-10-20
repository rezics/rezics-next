import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadLimit, WorkReadMissing, WorkReadMoved,
  WorkReadUnavailable, WorkReadInvalid, readDependencyToken, type WorkReadSession } from '../work/read-session.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { workTypeEntries } from '../types/registry.ts';
import { publishedStructuredWork } from '../work/public-patterns.ts';
import { FALLBACK_POLICY } from '../media/summary.ts';
import { readStudioChapterCount, STUDIO_CHAPTER_COUNT_COST } from './chapters.ts';

export const STUDIO_WORK_COST = { pageSize: 20, candidateAdmissions: 200, textsPerPage: 200,
  submissionsPerPage: 200, inventoryBatches: 5, graphCalls: 140, accessCalls: 12 } as const;
export const STUDIO_WORK_DETAIL_COST = { graphCalls: 4, accessCalls: 4,
  texts: 200, submissions: 200 } as const;
const types = ['https://schema.org/Book', 'https://schema.org/DigitalDocument',
  'https://schema.org/Recipe'] as const;
type WorkType = typeof types[number];
// Credits classify the original authoring intent. Current maintainer/controller
// proofs alone confer Studio authority; a recipient never needs creator credits.
const writerCreditPattern = (work: string, writer: string) => `
  GRAPH ${iri(GRAPHS.current)} { ?credit a rv:NativeAgentCredit ; rv:work ${work} ;
    rv:agent ${writer} ; schema:roleName "author" ; rv:creditRevision ?creditHead .
    FILTER NOT EXISTS { ?credit rv:retiredBy ?retirement } }
  GRAPH ${iri(GRAPHS.revisions)} { ?creditHead a rv:NativeAgentCreditRevision ;
    rv:component ?credit ; rv:work ${work} ; rv:agent ${writer} .
    FILTER NOT EXISTS { ?creditHead a rv:ErasedRevision } }`;

/** Recipe state follows its Structure publication, independently of optional notes. */
export function studioWorkState(texts: readonly { publicationHead: string | null }[], recipe?: {
  started: boolean; published: boolean;
}): 'published' | 'draft' | 'empty' {
  if (recipe) return recipe.published ? 'published' : recipe.started || texts.length ? 'draft' : 'empty';
  return texts.some(text => text.publicationHead) ? 'published' : texts.length ? 'draft' : 'empty';
}

const recipeStateBindings = (work: string, main: string) => `
  BIND(EXISTS { GRAPH ${iri(GRAPHS.current)} { ?studioRecipe a rv:Structure ; rv:structureOf ${main} ;
    rv:structureProfile rv:RecipeComposition ; rv:structureHead ?studioRecipeHead . } } AS ?recipeStarted)
  BIND(EXISTS { ${publishedStructuredWork(work, main)} } AS ?recipePublished)`;

export interface StudioWorkFilters { state?: 'draft' | 'published' | 'empty'; type?: WorkType;
  view?: 'authored' | 'curated'; q?: string; sort?: 'recent' | 'created' | 'title' }

/** One normalization for title matching, ordering and continuation identity. */
export const studioTitleKey = (title: string) => title.normalize('NFKC').toLowerCase();
export function studioSearchQuery(query = ''): string {
  if ([...query].length > 200 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(query)) {
    throw new WorkReadInvalid('Title query exceeds 200 Unicode scalar values');
  }
  return studioTitleKey(query).trim();
}
const scalarCompare = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));

/**
 * Global title order needs the complete authorized cut, never a sorted candidate
 * window. Five indexed batches bound this owner read; an over-budget inventory
 * is unavailable rather than silently omitting later matching titles.
 */
async function inventoryCut(session: WorkReadSession, agent: string) {
  const access = session.deps.studioAccess!, principal = session.principal!;
  const rows: Awaited<ReturnType<typeof access.studioWorks>>['rows'] = [];
  let after = '', stamp: string | undefined;
  for (let batch = 0; batch < STUDIO_WORK_COST.inventoryBatches; batch++) {
    const page = await access.studioWorks(principal, agent, after, STUDIO_WORK_COST.candidateAdmissions + 1);
    if (stamp !== undefined && stamp !== page.stamp) throw new WorkReadMoved('Studio controller changed');
    stamp = page.stamp;
    rows.push(...page.rows.slice(0, STUDIO_WORK_COST.candidateAdmissions));
    if (page.rows.length <= STUDIO_WORK_COST.candidateAdmissions) return { rows, stamp };
    after = rows.at(-1)!.work;
  }
  throw new WorkReadLimit('Studio inventory exceeds complete ordering budget');
}

/** Exact Agent Work, including chapters omitted from the inventory. One Work
 * graph head and at most 200 of the Agent's texts and submissions. */
export async function readStudioWork(session: WorkReadSession, agent: string, work: string) {
  const principal = session.principal;
  const access = session.deps.studioAccess;
  if (!principal || !access || session.options.actingSubject !== agent) {
    throw new WorkReadUnavailable('Studio authority is unavailable');
  }
  const first = await access.studioWork(principal, agent, work);
  if (!first.row) throw new WorkReadMissing('Studio Work is unavailable');
  const heads = await session.query(`SELECT ?main ?head ?mainHead ?title ?disclosure ?recipeStarted ?recipePublished WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a schema:CreativeWork ; rv:head ?head ;
      rv:mainVersion ?main ; rdfs:label ?title .
      ?main a rv:MainVersion ; rv:head ?mainHead ; rv:work ${iri(work)} .
      OPTIONAL { ${iri(work)} rv:disclosure ?disclosure }
      FILTER NOT EXISTS { ${iri(work)} rv:protectionHead ?protection } }
    ${recipeStateBindings(iri(work), "?main")}
  } LIMIT 2`, 2);
  if (heads.length !== 1 || !heads[0]?.main || !heads[0]?.head || !heads[0]?.mainHead
    || !heads[0]?.title) throw new WorkReadMissing('Studio Work is unavailable');
  const head = heads[0];
  const credits = first.row.action === 'work.edit' ? [] : await session.query(`SELECT ?credit WHERE {
    ${writerCreditPattern(iri(work), iri(first.row.writer))}
  } LIMIT 2`, 2);
  const typeRows = await session.query(`SELECT ?type WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(work)} a ?type . FILTER(?type IN (${types.map(type => `<${type}>`).join(', ')}))
  } } LIMIT ${types.length + 1}`, types.length + 1);
  // The selected draft must remain optional within this contribution's publication
  // edge; a separate OPTIONAL can bind an unrelated publication to an unpublished text.
  const textRows = await session.query(`SELECT ?contribution ?language ?draft ?publication ?selected WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?contribution a rv:TextContribution ; rv:work ${iri(work)} ;
      rv:author ${iri(agent)} ; rv:language ?language ; rv:draftHead ?draft . }
    OPTIONAL {
      GRAPH ${iri(GRAPHS.current)} { ?contribution rv:publicationHead ?publication . }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?publication rv:selectedDraft ?selected . } }
    }
  } LIMIT ${STUDIO_WORK_DETAIL_COST.texts + 1}`, STUDIO_WORK_DETAIL_COST.texts + 1);
  if (textRows.length > STUDIO_WORK_DETAIL_COST.texts) throw new WorkReadLimit('Studio texts exceed Work budget');
  const texts = textRows.map(row => {
    if (!row.contribution || !row.language || !row.draft) throw new WorkReadUnavailable('Studio text is incomplete');
    return { contribution: row.contribution.value, language: row.language.value,
      draftHead: row.draft.value, publicationHead: row.publication?.value ?? null,
      publicationDraft: row.selected?.value ?? null };
  });
  const details = await access.studioWorkDetails(principal, agent, [work]);
  const summary = await session.summaries([work]);
  const cover = summary.find(item => item.reference === work);
  const chapterCount = typeRows.some(row => row.type?.value === types[0])
    ? await readStudioChapterCount(session, work, head.main!.value) : null;
  const again = await access.studioWork(principal, agent, work);
  const finalDetails = await access.studioWorkDetails(principal, agent, [work]);
  if (again.stamp !== first.stamp || JSON.stringify(finalDetails) !== JSON.stringify(details)) {
    throw new WorkReadMoved('Studio Work authority or details changed');
  }
  const createdAt = first.row.created_at.toISOString();
  const updatedAt = new Date(first.row.updated_key).toISOString();
  return { item: { id: work, mainVersion: head.main.value, workRevision: head.head.value,
    mainRevision: head.mainHead.value,
    title: { value: head.title.value, language: head.title['xml:lang'] ?? 'und' },
    relationship: first.row.action === 'work.edit' || credits.length ? 'authored' as const : 'curated' as const,
    cover: cover?.status === 'available' ? cover.avatar : { kind: 'fallback' as const,
      policy: FALLBACK_POLICY, key: work, resourceType: 'work' as const },
    types: typeRows.map(row => row.type?.value).filter((value): value is string => !!value),
    disclosure: head.disclosure?.value === `${RV}Public` ? 'public' as const : 'restricted' as const,
    state: studioWorkState(texts, workTypeEntries.some(entry => entry.presentation === 'recipe' && typeRows.some(row => row.type?.value === entry.type))
      ? { started: head.recipeStarted?.value === 'true', published: head.recipePublished?.value === 'true' } : undefined),
    texts, submissions: details.submissions.map(item => ({ id: item.id, realm: item.realm,
      state: item.state, openedAt: item.opened_at.toISOString(), updatedAt: item.updated_at.toISOString() })),
    chapterCount, createdAt, updatedAt }, sourcePosition: session.position };
}

/** Agent control is fenced before and after this bounded cross-owner read. */
export async function readStudioWorks(session: WorkReadSession, agent: string,
  filters: StudioWorkFilters) {
  const principal = session.principal;
  const access = session.deps.studioAccess;
  if (!principal || !access || session.options.actingSubject !== agent) {
    throw new WorkReadUnavailable('Studio authority is unavailable');
  }
  const limit = session.options.limit ?? 20;
  const view = filters.view ?? 'authored';
  // Control precedes query and cursor diagnostics, including borrowed cursors.
  const first = await access.studioWorks(principal, agent, '', 1);
  const q = studioSearchQuery(filters.q);
  const sort = filters.sort ?? 'recent';
  if (!['recent', 'created', 'title'].includes(sort)) throw new WorkReadInvalid('Studio order is invalid');
  const cut = await inventoryCut(session, agent);
  if (cut.stamp !== first.stamp) throw new WorkReadMoved('Studio controller changed');
  const binding = ['studio-works-v4', agent, view, filters.state ?? null, filters.type ?? null, q, sort, limit];
  const position = { ...session.position, dependencyToken: readDependencyToken([session.position, cut]) };
  const cursor = decodeReadCursor(session.options.cursor, binding, position);
  const byAdmission = new Map(cut.rows.map(row => [row.id, row]));
  const workRows: import('../work/read-session.ts').ReadRow[] = [];
  for (let offset = 0; offset < cut.rows.length; offset += STUDIO_WORK_COST.candidateAdmissions) {
    const proven = cut.rows.slice(offset, offset + STUDIO_WORK_COST.candidateAdmissions)
      .filter(row => row.generation !== null);
    const batchRows = proven.length ? await session.query(`SELECT ?admission ?work ?main ?head ?mainHead ?title
      ?disclosure ?recipeStarted ?recipePublished ?hasText ?hasPublication ?isRecipe WHERE {
        VALUES (?admission ?writer) { ${proven.map(row => `(${lit(row.id)} ${iri(row.writer)})`).join(' ')} }
        GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ; rv:admissionId ?admission ;
          rv:outcome rv:Succeeded ; rv:work ?work ; rv:mainVersion ?main .
        }
        GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork ; rv:head ?head ;
          rv:mainVersion ?main ; rdfs:label ?title .
          ?main a rv:MainVersion ; rv:head ?mainHead ; rv:work ?work .
          OPTIONAL { ?work rv:disclosure ?disclosure }
          FILTER NOT EXISTS { ?work rv:protectionHead ?protection }
        }
        FILTER ${view === 'authored' ? 'EXISTS' : 'NOT EXISTS'} {
          ${writerCreditPattern('?work', '?writer')}
        }
        ${filters.type ? `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} { ?work a <${filters.type}> } }` : ''}
        BIND(EXISTS { GRAPH ${iri(GRAPHS.current)} { ?ownText a rv:TextContribution ; rv:work ?work ;
          rv:author ${iri(agent)} ; rv:draftHead ?ownDraft . } } AS ?hasText)
        BIND(EXISTS { GRAPH ${iri(GRAPHS.current)} { ?ownText a rv:TextContribution ; rv:work ?work ;
          rv:author ${iri(agent)} ; rv:draftHead ?ownDraft ; rv:publicationHead ?ownPublication . } } AS ?hasPublication)
        BIND(EXISTS { GRAPH ${iri(GRAPHS.current)} { ?work a schema:Recipe } } AS ?isRecipe)
        ${recipeStateBindings("?work", "?main")}
      } LIMIT ${STUDIO_WORK_COST.candidateAdmissions + 1}`,
    STUDIO_WORK_COST.candidateAdmissions + 1) : [];
    if (batchRows.length > STUDIO_WORK_COST.candidateAdmissions) throw new WorkReadLimit('Studio candidate batch exceeded');
    workRows.push(...batchRows);
  }
  if (new Set(workRows.map(row => row.admission?.value)).size !== workRows.length
    || workRows.some(row => {
      const candidate = byAdmission.get(row.admission?.value ?? '');
      return !candidate || candidate.generation === null || candidate.work !== row.work?.value || !row.title;
    })) throw new WorkReadUnavailable('Studio Work receipt is ambiguous');
  const matching = workRows.filter(row => {
    const title = studioTitleKey(row.title!.value);
    const ownTexts = row.hasText?.value === 'true'
      ? [{ publicationHead: row.hasPublication?.value === 'true' ? 'published' : null }] : [];
    const state = studioWorkState(ownTexts, row.isRecipe?.value === 'true'
      ? { started: row.recipeStarted?.value === 'true', published: row.recipePublished?.value === 'true' } : undefined);
    return (!q || title.includes(q)) && (!filters.state || state === filters.state);
  });
  matching.sort((left, right) => {
    const a = byAdmission.get(left.admission!.value)!, b = byAdmission.get(right.admission!.value)!;
    const key = sort === 'title' ? scalarCompare(studioTitleKey(left.title!.value), studioTitleKey(right.title!.value))
      : scalarCompare(sort === 'recent' ? b.updated_key : b.created_key,
        sort === 'recent' ? a.updated_key : a.created_key);
    return key || scalarCompare(a.work, b.work);
  });
  const start = cursor ? matching.findIndex(row => row.work?.value === cursor.after) + 1 : 0;
  if (cursor && !start) throw new WorkReadInvalid('Studio continuation anchor is unavailable');
  const selectedRows = matching.slice(start, start + limit);
  const workIds = selectedRows.map(row => row.work?.value).filter((value): value is string => !!value);
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
    }
    OPTIONAL {
      GRAPH ${iri(GRAPHS.current)} { ?contribution rv:publicationHead ?publication . }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?publication rv:selectedDraft ?selected . } }
    }
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
  const summary = await session.summaries(workIds);
  const covers = new Map(summary.map(item => [item.reference, item]));
  const items = selectedRows.flatMap(row => {
    const admission = byAdmission.get(row.admission?.value ?? '');
    if (!admission || !row.work || !row.main || !row.head || !row.mainHead || !row.title) {
      throw new WorkReadUnavailable('Studio Work is incomplete');
    }
    const work = row.work.value;
    const ownTexts = texts.get(work) ?? [];
    const workTypes = typeMap.get(work) ?? [];
    const state = studioWorkState(ownTexts, workTypeEntries.some(entry => entry.presentation === 'recipe' && workTypes.includes(entry.type))
      ? { started: row.recipeStarted?.value === 'true', published: row.recipePublished?.value === 'true' } : undefined);
    const cover = covers.get(work);
    const createdAt = admission.created_at.toISOString();
    const updatedAt = new Date(admission.updated_key).toISOString();
    const language = row.title['xml:lang'] ?? 'und';
    return [{ id: work, mainVersion: row.main.value, workRevision: row.head.value,
      mainRevision: row.mainHead.value, title: { value: row.title.value, language },
      relationship: view,
      cover: cover?.status === 'available' ? cover.avatar : { kind: 'fallback' as const,
        policy: FALLBACK_POLICY, key: work, resourceType: 'work' as const },
      types: workTypes, disclosure: row.disclosure?.value === `${RV}Public` ? 'public' as const
        : 'restricted' as const, state, texts: ownTexts,
      submissions: details.submissions.filter(item => item.work === work).map(item => ({
        id: item.id, realm: item.realm, state: item.state,
        openedAt: item.opened_at.toISOString(), updatedAt: item.updated_at.toISOString() })),
      createdAt, updatedAt }];
  });
  const countBudget = { remaining: STUDIO_CHAPTER_COUNT_COST.pagesPerInventory };
  const countedItems = [];
  for (const item of items) countedItems.push({ ...item, chapterCount: item.types.includes(types[0])
    ? await readStudioChapterCount(session, item.id, item.mainVersion, countBudget) : null });
  const again = await inventoryCut(session, agent);
  if (JSON.stringify(again) !== JSON.stringify(cut)) throw new WorkReadMoved('Studio Work inventory changed');
  const more = start + selectedRows.length < matching.length;
  return pageResult(session, countedItems, more
    ? encodeReadCursor(binding, position, selectedRows.at(-1)!.work!.value) : null);
}
