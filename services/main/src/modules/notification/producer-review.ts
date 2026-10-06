import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import type { NotificationSubjectReader, SubjectResolution } from './dispatcher.ts';
import type { NotificationEvent } from './store.ts';
import { reviewVisibleSql } from '../review/store.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { reviewTarget } from '../review/read.ts';
import { WorkReadMissing } from '../work/read-session.ts';
import { publicTargetRead } from '../target/resolve.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const hidden: SubjectResolution = { status: 'undisclosed' };
const limit = 256;
type ReviewKind = 'review_created' | 'review_helpful_milestone';

async function publicAuthors(graph: Pick<FusekiClient, 'query'>, work: string): Promise<string[]> {
  if (!native.test(work)) return [];
  const rows = (await graph.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?author WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?contribution a rv:TextContribution ;
      rv:author ?author ; rv:publicationHead ?decision .
      { ?contribution rv:work ${iri(work)} } UNION
      { FILTER(?contribution = ${iri(work)}) } }
    GRAPH ${iri(GRAPHS.revisions)} { ?decision rv:disclosure rv:Public . }
  } LIMIT ${limit + 1}`, 16_384)).results?.bindings ?? [];
  if (rows.length > limit) throw new Error('review author bound exceeded');
  return rows.map(row => row.author?.value ?? '').filter(native.test.bind(native));
}

/** Use the review reader's Context/Work decision, including Realm protection and the selected Main version. */
async function currentReviewTarget(graph: Pick<FusekiClient, 'query'>,
  row: { context: string; work: string; realm: string | null; main_version: string }): Promise<boolean> {
  if (!native.test(row.work) || !native.test(row.main_version)) return false;
  try { iri(row.context); } catch { return false; }
  try {
    const target = await publicTargetRead(graph, session => reviewTarget(session, row.context, row.work));
    return target.realm === row.realm && target.mainVersion === row.main_version;
  } catch (error) {
    if (error instanceof WorkReadMissing) return false;
    throw error;
  }
}

/** Producer events are appended by the review writer's Access transaction. */
export async function reviewNotification(access: Pool | PoolClient, graph: Pick<FusekiClient, 'query'>,
  kind: ReviewKind, eventId: string): Promise<NotificationEvent | null> {
  const row = (await access.query<{ id: string; revision: string; principal_id: string;
    acting_subject: string; context: string; work: string; main_version: string;
    realm: string | null; milestone: number | null }>(`
    SELECT r.id::text, r.revision::text, r.principal_id::text, r.acting_subject,
      r.context, r.work, r.main_version, r.realm, m.milestone
    FROM access.reader_review_event ev JOIN access.reader_review r ON r.id = ev.review_id
    LEFT JOIN access.reader_review_milestone m ON m.event_id = ev.id
    WHERE ev.id = $1 AND ev.kind = $2 AND NOT r.deleted
      AND ($2 <> 'created' OR ev.revision = r.revision) AND ${reviewVisibleSql}`,
  [eventId, kind === 'review_created' ? 'created' : 'helpful-changed'])).rows[0];
  if (!row || kind === 'review_helpful_milestone' && !row.milestone
    || !await currentReviewTarget(graph, row)) return null;
  let recipients: string[];
  if (kind === 'review_created') {
    const authors = (await publicAuthors(graph, row.work)).filter(author => author !== row.acting_subject);
    if (!authors.length) return null;
    const found = (await access.query<{ id: string }>(`SELECT DISTINCT p.id::text FROM access.representation rep
      JOIN access.principal p ON p.id = rep.principal_id AND p.active
      JOIN access.authority_subject s ON s.id = rep.subject_id AND s.active AND s.kind = 'agent'
      WHERE rep.subject_id = ANY($1::text[]) AND rep.active AND rep.valid_until > clock_timestamp()
        AND p.id <> $2 ORDER BY p.id::text LIMIT $3`, [authors, row.principal_id, limit + 1])).rows;
    if (found.length > limit) throw new Error('review notification recipient bound exceeded');
    recipients = found.map(item => item.id);
  } else {
    const active = (await access.query<{ id: string }>(`SELECT id::text FROM access.principal
      WHERE id = $1 AND active`, [row.principal_id])).rows[0];
    recipients = active ? [active.id] : [];
  }
  if (!recipients.length) return null;
  const helpful = kind === 'review_helpful_milestone';
  return { sourceOwner: 'access', sourceEvent: `${kind}:${eventId}`, purpose: 'social',
    topic: helpful ? 'review-helpful' : 'review',
    subject: { owner: 'access', ref: row.id, revision: row.revision },
    disclosureBasis: helpful ? 'review-helpful-v1' : 'review-created-v1', recipients,
    display: { kind: helpful ? 'review_helpful' : 'review', actorAgent: helpful ? null : row.acting_subject,
      realm: row.realm, groupKey: row.work } };
}

/** Recheck disclosure and recipient authority at inbox read and delivery. */
export async function reviewSubject(access: Pool, graph: Pick<FusekiClient, 'query'>,
  input: Parameters<NotificationSubjectReader['resolve']>[0]): Promise<SubjectResolution> {
  if (input.owner !== 'access' || !/^[0-9a-f-]{36}$/.test(input.ref)
    || !['review-created-v1', 'review-helpful-v1'].includes(input.disclosureBasis)) return hidden;
  const row = (await access.query<{ principal_id: string; acting_subject: string; context: string;
    work: string; main_version: string; realm: string | null; revision: string;
    body: string; spoiler: boolean }>(`SELECT r.principal_id::text,
      r.acting_subject, r.context, r.work, r.main_version, r.realm, r.revision::text,
      r.body, r.spoiler FROM access.reader_review r
      WHERE r.id = $1 AND NOT r.deleted AND ${reviewVisibleSql}`, [input.ref])).rows[0];
  if (!row || row.realm !== (input.realm ?? null) || row.revision !== input.revision
    || !await currentReviewTarget(graph, row)) return hidden;
  if (input.disclosureBasis === 'review-helpful-v1') {
    if (row.principal_id !== input.principalId) return hidden;
  } else {
    const authors = await publicAuthors(graph, row.work);
    if (!authors.length) return hidden;
    const represented = await access.query(`SELECT 1 FROM access.representation rep
      JOIN access.principal p ON p.id = rep.principal_id AND p.active
      JOIN access.authority_subject s ON s.id = rep.subject_id AND s.active AND s.kind = 'agent'
      WHERE p.id = $1 AND rep.subject_id = ANY($2::text[]) AND rep.active
        AND rep.valid_until > clock_timestamp() LIMIT 1`, [input.principalId, authors]);
    if (!represented.rowCount) return hidden;
  }
  const current = (await access.query(`SELECT 1 FROM access.reader_review r
    WHERE r.id = $1 AND r.revision = $2 AND r.context = $3 AND r.work = $4
      AND r.main_version = $5 AND r.realm IS NOT DISTINCT FROM $6
      AND NOT r.deleted AND ${reviewVisibleSql}`, [input.ref, row.revision, row.context,
    row.work, row.main_version, row.realm])).rowCount === 1;
  if (!current || !await currentReviewTarget(graph, row)) return hidden;
  return { status: 'available', subject: { private: false,
    fields: { linkTarget: row.work, reviewId: input.ref, ...(row.realm ? { realm: row.realm } : {}),
      ...(!row.spoiler ? { excerpt: row.body.slice(0, 240) } : {}) } } };
}
