import { GRAPHS, iri } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadMissing, WorkReadMoved, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { readPost } from './read.ts';
import { readMetadataHeader, selectedMetadata } from '../work/metadata-read.ts';
import { POST_IDENTIFICATION_COST } from './identification-schema.ts';
import type { IdentificationRecord } from './identification-store.ts';

const initial = '';
async function visible(session: WorkReadSession, record: IdentificationRecord, evidence = false) {
  if (!record.result) return null;
  const result = record.result;
  const [work, book] = await session.summaries(evidence ? [result.work, record.intent.placement.book] : [result.work]);
  if (work?.status !== 'available' || evidence && book?.status !== 'available') return null;
  const heads = await session.query(`SELECT ?metadata WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(result.work)} rv:head ?head . OPTIONAL { ${iri(result.work)} rv:descriptiveMetadataHead ?metadata }
  } } LIMIT 2`, 2);
  if (heads.length !== 1) throw new WorkReadMoved('Identification Work changed');
  const metadata = await readMetadataHeader(session, result.work, heads[0]?.metadata?.value ?? null);
  return { ...result, title: selectedMetadata(metadata, session.options.language).title ?? work.name };
}

/** A receipt remains evidence after retirement, but grants no disclosure. */
export async function readPostIdentification(session: WorkReadSession, id: string) {
  const record = await session.deps.postIdentifications?.read(id);
  if (!record?.result) throw new WorkReadMissing('Identification is unavailable');
  await readPost(session, record.post);
  const result = await visible(session, record, true);
  if (!result) throw new WorkReadMissing('Identification is unavailable');
  return result;
}

/** O(scan) bounded visibility probes over an indexed receipt keyset; a continuation
 * includes only the last visible identity, never a suppressed Work or Book. */
export async function readPostIdentifications(session: WorkReadSession, post: string) {
  const store = session.deps.postIdentifications;
  if (!store) throw new WorkReadUnavailable('Identification owner is unavailable');
  await readPost(session, post);
  const generation = await store.position(post), binding = ['post-identifications-v2', post,
    session.options.actingSubject ?? null, session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  if (cursor && cursor.order !== generation) throw new WorkReadMoved('Identification inventory changed');
  const rows = await store.page(post, cursor?.after ?? initial, POST_IDENTIFICATION_COST.scan + 1);
  const items = [], limit = session.options.limit ?? POST_IDENTIFICATION_COST.page;
  let next: string | null = null;
  for (const record of rows.slice(0, POST_IDENTIFICATION_COST.scan)) {
    const result = record.result!;
    // Retiring the part-of relation changes its Book membership, independently
    // of the Work's realization. Only its live Post placement decides this link.
    const active = await session.query(`SELECT ?structure ?occurrence WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(result.work)} a schema:CreativeWork ; rv:mainVersion ?main .
      ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureProfile rv:BookComposition ; rv:selectedGeneration ?generation .
      ?generation rv:generationState rv:Active .
      ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrence ?occurrence ;
        rv:occurrenceRole rv:ChapterRole ; <https://schema.org/item> ${iri(post)} .
      FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
    } } ORDER BY ?occurrence LIMIT 2`, 2);
    if (!active[0]?.structure || !active[0]?.occurrence) continue;
    const item = await visible(session, record);
    if (!item) continue;
    if (items.length === limit) { next = encodeReadCursor(binding, session.position,
      items[items.length - 1]!.work, generation); break; }
    // A private source Book's evidence is not needed to name the public Work.
    items.push({ identification: item.identification, work: item.work, mainVersion: item.mainVersion,
      structure: active[0].structure.value, occurrence: active[0].occurrence.value, title: item.title, receipt: item.receipt });
  }
  if (!next && rows.length > POST_IDENTIFICATION_COST.scan) {
    throw new WorkReadUnavailable('Identification visibility scan exceeds its budget');
  }
  if (await store.position(post) !== generation) throw new WorkReadMoved('Identification inventory changed');
  await readPost(session, post);
  return { profile: 'post-identifications-v1' as const, post, ...pageResult(session, items, next) };
}
