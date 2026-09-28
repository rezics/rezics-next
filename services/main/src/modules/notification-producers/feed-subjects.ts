import type { Pool } from 'pg';
import type { ContentCore } from '../../../../content/src/core.ts';
import type { NotificationSubjectReader, SubjectResolution } from '../notification/dispatcher.ts';
import { feedReviewSources, feedSources, type FeedSource } from '../feed/source.ts';
import type { ReaderReviews } from '../review/store.ts';
import { READ_PREFIX, type WorkReadSession } from '../work/read-session.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { notificationWorkTitle } from '../notification/display.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const hidden: SubjectResolution = { status: 'undisclosed' };
/** One exact current Feed source, up to two graph reads and one Content read. */
export const FEED_NOTIFICATION_COST = { sourceRows: 1, sourceReads: 2,
  follows: 2, recipientRepresentations: 1 } as const;

/** Subject disclosure repeats both the current public Feed gate and the
 * recipient relationship; an old Access event never grants a durable read. */
export function feedNotificationSubjectReader(access: Pool, env: WorkActivationEnvironment,
  content: Pick<ContentCore, 'readExactBatch'>, reviews: ReaderReviews): NotificationSubjectReader {
  const eligible = async (principal: string, basis: string, work: string | null,
    author: string, ref: string, revision: string): Promise<boolean> => {
    if (basis === 'followed-chapter-v1') {
      if (!work) return false;
      const following = await access.query(`SELECT 1 FROM access.follow f
        JOIN access.principal p ON p.id = f.principal_id AND p.active
        WHERE f.principal_id = $1 AND f.following AND ((f.kind = 'work' AND f.target = $2)
          OR (f.kind = 'agent' AND f.target = $3)) LIMIT 1`, [principal, work, author]);
      return !!following.rowCount;
    }
    const represented = await access.query(`SELECT 1 FROM access.feed_post_vote_event e
      JOIN access.feed_vote v ON v.principal_id = e.voter_principal AND v.target = e.target
        AND v.revision = e.vote_revision AND v.value = 1
      JOIN access.representation r ON r.subject_id = e.author AND r.principal_id = $1
        AND r.active AND r.valid_until > clock_timestamp()
      JOIN access.principal p ON p.id = r.principal_id AND p.active
      WHERE e.target = $2 AND e.vote_revision = $3 AND e.author = $4 LIMIT 1`,
    [principal, ref, revision, author]);
    return !!represented.rowCount;
  };
  const source = async (activity: string): Promise<FeedSource | null> => {
    await assertGraphAdmissionOpen(env.fuseki, env.lineage);
    const session = { deps: { content, reviews }, query: async (body: string, limit: number) => {
      const rows = (await env.fuseki.query(`${READ_PREFIX}\n${body}`, 16_384)).results?.bindings ?? [];
      if (rows.length > limit) throw new Error('Feed notification source bound exceeded');
      return rows;
    } } as unknown as WorkReadSession;
    const review = (await access.query<{ id: string }>(`SELECT id FROM access.reader_review
      WHERE id = $1`, [activity.slice(-36)])).rows[0];
    const rows = review ? await feedReviewSources(session, [activity])
      : await feedSources(session, { ids: [activity] });
    await assertGraphAdmissionOpen(env.fuseki, env.lineage);
    return rows[0]?.id === activity ? rows[0] : null;
  };
  return { async resolve(input): Promise<SubjectResolution> {
    if (input.owner !== 'graph' || !native.test(input.ref) || !input.revision) return hidden;
    const chapter = input.disclosureBasis === 'followed-chapter-v1';
    if (!chapter && input.disclosureBasis !== 'post-vote-v1') return hidden;
    let author: string;
    if (chapter) {
      const row = (await access.query<{ work: string; author: string; content_revision: string }>(`
        SELECT work, author, content_revision FROM access.chapter_notification_event
        WHERE activity = $1 AND content_revision = $2`, [input.ref, input.revision])).rows[0];
      if (!row) return hidden;
      if (!await eligible(input.principalId, input.disclosureBasis, row.work,
        row.author, input.ref, input.revision)) return hidden;
      author = row.author;
    } else {
      const row = (await access.query<{ author: string }>(`SELECT e.author
        FROM access.feed_post_vote_event e JOIN access.feed_vote v
          ON v.principal_id = e.voter_principal AND v.target = e.target
          AND v.revision = e.vote_revision AND v.value = 1
        WHERE e.target = $1 AND e.vote_revision = $2`, [input.ref, input.revision])).rows[0];
      if (!row) return hidden;
      if (!await eligible(input.principalId, input.disclosureBasis, null,
        row.author, input.ref, input.revision)) return hidden;
      author = row.author;
    }
    const current = await source(input.ref);
    if (!current || current.actor !== author || chapter && (!current.occurrence
      || current.contentRevision !== input.revision)) return hidden;
    const title = current.work ? await notificationWorkTitle(env, current.work) : null;
    const after = await source(input.ref);
    if (!after || after.actor !== current.actor || after.contentRevision !== current.contentRevision
      || after.work !== current.work || after.occurrence !== current.occurrence) return hidden;
    if (!await eligible(input.principalId, input.disclosureBasis, current.work,
      author, input.ref, input.revision)) return hidden;
    return { status: 'available', subject: { private: false, fields: {
      ...(current.work ? { linkTarget: current.work } : {}), ...(title ? { title } : {}) } } };
  } };
}
