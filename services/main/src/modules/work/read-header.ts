import { chooseMainLanguage, readMainLanguageHeads } from './selection-heads.ts';
import type { Static } from 'typebox';
import { iri, GRAPHS, WORK_SEMANTIC_TYPES } from './activate.ts';
import { workCard, workHeader } from './read-contract.ts';
import { WorkReadMissing, WorkReadUnavailable, publicWork, unerased, type WorkReadSession } from './read-session.ts';
import { readMetadataHeader, recordedDisplayText, selectedMetadata } from './metadata-read.ts';

export type WorkCard = Static<typeof workCard>;
export interface WorkBasis { card: WorkCard; mainRevision: string; selectedLanguage: string | null;
  metadataRevision: string | null; metadata: Awaited<ReturnType<typeof readMetadataHeader>>;
  disclosure: 'public' | 'restricted'; fieldProvenance?: Static<typeof workHeader>['fieldProvenance'] }

export async function readWorkBasis(session: WorkReadSession, work: string): Promise<WorkBasis> {
  const types = `OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
    ${iri(work)} a ?type . VALUES ?type { ${WORK_SEMANTIC_TYPES.map(type => `<${type}>`).join(' ')} } } }`;
  const maximumRows = 9;
  const rows = await session.query(`SELECT ?head ?main ?mainHead ?metadataHead ?type ?public ?provisional ?provenance
    WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(work)} a schema:CreativeWork ; rv:head ?head ; rv:mainVersion ?main .
      ?main a rv:MainVersion ; rv:work ${iri(work)} ; rv:head ?mainHead .
      OPTIONAL { ${iri(work)} rv:descriptiveMetadataHead ?metadataHead }
      OPTIONAL { ${iri(work)} rv:provisional ?provisional }
      OPTIONAL { ${iri(work)} rv:fieldProvenance ?provenance }
    }
    ${types}
    ${unerased(iri(work))}
    BIND(EXISTS { ${publicWork(iri(work), '?main')} } AS ?public)
  } LIMIT ${maximumRows + 1}`, maximumRows);
  const row = rows[0];
  if (!row) throw new WorkReadMissing('Work is unavailable');
  if (!row.head || !row.main || !row.mainHead || !row.public
    || ['head', 'main', 'mainHead', 'metadataHead', 'public', 'provenance'].some(key =>
      new Set(rows.map(item => item[key]?.value)).size !== 1)) {
    throw new WorkReadUnavailable('Work basis is ambiguous');
  }
  const isPublic = row.public.value === 'true';
  if (!isPublic && (!session.principal || !session.options.actingSubject
    || !await session.deps.access.canReadWork(session.principal, session.options.actingSubject, work))) {
    throw new WorkReadMissing('Work is unavailable');
  }
  const selected = isPublic ? chooseMainLanguage(await readMainLanguageHeads(session.deps.environment,
    row.main.value, true), session.options.language) : null;
  const summary = (await session.summaries([work]))[0];
  if (summary?.status !== 'available' || summary.type !== 'work') throw new WorkReadMissing('Work is unavailable');
  const metadata = await readMetadataHeader(session, work, row.metadataHead?.value ?? null);
  const selectedMetadataValue = selectedMetadata(metadata, session.options.language);
  const stats = (await session.deps?.serialStats?.batch([work], session.position.sequence))?.get(work);
  return { card: { id: work, revision: row.head.value, mainVersion: row.main.value,
    ...(row.provisional ? { verification: row.provisional.value === 'true' ? 'unverified' as const : 'verified' as const } : {}),
    title: summary.name, cover: summary.avatar, types: [...new Set(rows.flatMap(item => item.type ? [item.type.value] : []))].sort(),
    tagline: selectedMetadataValue.tagline, completionStatus: metadata.completionStatus,
    chapterCount: stats?.chapterCount ?? null, wordCount: stats?.wordCount ?? null,
    lastUpdatedAt: stats?.lastUpdatedAt ?? null },
  mainRevision: row.mainHead.value, metadataRevision: row.metadataHead?.value ?? null, metadata,
  selectedLanguage: selected?.language ?? null,
  disclosure: isPublic ? 'public' : 'restricted',
  ...(row.provenance ? { fieldProvenance: JSON.parse(row.provenance.value) as Static<typeof workHeader>['fieldProvenance'] } : {}) };
}

/** Repeat the admission after hydration; Access restrictions need not move the graph. */
export async function fenceWorkBasis(session: WorkReadSession, basis: WorkBasis): Promise<void> {
  if (basis.disclosure === 'restricted' && (!session.principal || !session.options.actingSubject
    || !await session.deps.access.canReadWork(session.principal, session.options.actingSubject, basis.card.id))) {
    throw new WorkReadMissing('Work is unavailable');
  }
  const summary = (await session.summaries([basis.card.id]))[0];
  if (summary?.status !== 'available') throw new WorkReadMissing('Work is unavailable');
}

export async function readWorkHeader(session: WorkReadSession, work: string) {
  const basis = await readWorkBasis(session, work);
  const metadata = basis.metadata;
  const selected = selectedMetadata(metadata, session.options.language);
  await fenceWorkBasis(session, basis);
  const path = `/v1/works/${work.slice(-36)}`;
  return { profile: 'work-read-v1' as const, ...basis.card, disclosure: basis.disclosure,
    ...(basis.fieldProvenance ? { fieldProvenance: basis.fieldProvenance } : {}),
    title: selected.title ?? basis.card.title, description: selected.description,
    tagline: selected.tagline, completionStatus: metadata.completionStatus,
    metadataRevision: metadata.revision,
    originalTitle: metadata.originalTitle ? recordedDisplayText(metadata.originalTitle) : null,
    mainVersionRevision: basis.mainRevision, mainVersionLabel: selected.mainVersionLabel,
    selectedLanguage: basis.selectedLanguage, sourcePosition: session.position,
    links: { versions: `${path}/versions`, classifications: `${path}/classifications`,
      adoptions: `${path}/adoptions`, ratings: `${path}/ratings`, history: `${path}/history`, credits: `${path}/credits`,
      metadata: `${path}/metadata`, editions: `${path}/editions` } };
}
