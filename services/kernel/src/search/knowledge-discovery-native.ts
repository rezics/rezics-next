import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Effect } from '../events/effects.ts';
import type { KnowledgeDiscoveryCandidate, KnowledgeDiscoverySource } from '../content/index.ts';
import { withConnection } from '../database/pool.ts';
import { SearchOperationError } from './operation-outcomes.ts';
import type { KnowledgeAssociation, KnowledgeDiscoveryStore, KnowledgePreparation } from './knowledge-discovery.ts';

/** No index payload carries private metadata or disclosure authority. */
export function createKnowledgeDiscoveryStore(pool: Pool, now: () => number): KnowledgeDiscoveryStore {
  return {
    id: randomUUID,
    async cut(subjectId) {
      const installed = await pool.query('SELECT version FROM search.knowledge_discovery_installation WHERE version=1');
      if (!installed.rowCount) return null;
      const result = await pool.query<{ sequence: string }>(
        'SELECT sequence::text FROM search.knowledge_discovery_subject WHERE subject_id=$1',
        [subjectId],
      );
      return result.rows[0]?.sequence ?? '0';
    },
    async page(subjectId, after, limit) {
      type Row = {
        subject_id: string;
        document_id: string;
        publication_id: string;
        revision_id: string;
        published_at: string;
        sequence: string;
      };
      const select = `SELECT a.subject_id,a.document_id,a.publication_id,a.revision_id,a.sequence::text,
          to_char(a.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS published_at
          FROM search.knowledge_discovery_association a`;
      const order = 'ORDER BY a.published_at DESC,a.document_id,a.publication_id';
      // Two disjoint anchored seeks keep descending time and ascending UUID ties indexed.
      // An OR predicate or ordering by the formatted output alias would lose this bound.
      const rows: Row[] = [];
      if (after) {
        rows.push(
          ...(
            await pool.query<Row>(
              `${select}
          WHERE a.subject_id=$1 AND a.published_at=$2::timestamptz
            AND (a.document_id,a.publication_id)>($3::uuid,$4::uuid)
          ${order} LIMIT $5`,
              [subjectId, after.publishedAt, after.documentId, after.publicationId, limit],
            )
          ).rows,
        );
      }
      if (rows.length < limit) {
        const older = after ? 'AND a.published_at<$3::timestamptz' : '';
        rows.push(
          ...(
            await pool.query<Row>(
              `${select} WHERE a.subject_id=$1 ${older}
          ${order} LIMIT $2`,
              after ? [subjectId, limit - rows.length, after.publishedAt] : [subjectId, limit],
            )
          ).rows,
        );
      }
      return rows.map((row): KnowledgeAssociation => ({
        subjectId: row.subject_id,
        documentId: row.document_id,
        publicationId: row.publication_id,
        revisionId: row.revision_id,
        publishedAt: row.published_at,
        sequence: row.sequence,
      }));
    },
    async load(id) {
      const result = await pool.query<{ revision: number; state: KnowledgePreparation }>(
        'SELECT revision,state FROM search.knowledge_discovery_preparation WHERE id=$1 AND expires_at>$2',
        [id, now()],
      );
      const row = result.rows[0];
      return row ? { ...row.state, revision: row.revision } : null;
    },
    async save(record, previousRevision) {
      if (previousRevision !== null) {
        const result = await pool.query(
          `UPDATE search.knowledge_discovery_preparation SET revision=$3,state=$4::jsonb
           WHERE id=$1 AND revision=$2 AND expires_at>$5`,
          [record.id, previousRevision, record.revision, JSON.stringify(record), now()],
        );
        return result.rowCount === 1;
      }
      return withConnection(pool, async (client) => {
        await client.query('BEGIN');
        try {
          // Cleanup spends at most 100 expired rows on existing request infrastructure, no new watcher.
          await client.query(
            `DELETE FROM search.knowledge_discovery_preparation WHERE id IN
            (SELECT id FROM search.knowledge_discovery_preparation WHERE expires_at<=$1 ORDER BY expires_at,id LIMIT 100)`,
            [now()],
          );
          // The subject counter serializes installation, quota admission and new observation cuts.
          await client.query(
            `INSERT INTO search.knowledge_discovery_subject(subject_id,sequence) VALUES ($1,0)
            ON CONFLICT DO NOTHING`,
            [record.subjectId],
          );
          await client.query('SELECT sequence FROM search.knowledge_discovery_subject WHERE subject_id=$1 FOR UPDATE', [
            record.subjectId,
          ]);
          const quota = await client.query(
            `SELECT id FROM search.knowledge_discovery_preparation
            WHERE subject_id=$1 AND expires_at>$2 LIMIT 256`,
            [record.subjectId, now()],
          );
          if (quota.rows.length === 256) throw new SearchOperationError('index_not_ready');
          const saved = await client.query(
            `INSERT INTO search.knowledge_discovery_preparation
            (id,subject_id,revision,state,expires_at) VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING`,
            [record.id, record.subjectId, record.revision, JSON.stringify(record), record.expiresAt],
          );
          await client.query('COMMIT');
          return saved.rowCount === 1;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },
  };
}

/** Serialize each subject's sequence until commit, so a captured cut cannot include a later
 * receiver transaction with an earlier allocated number. Duplicate native delivery is a no-op. */
export async function indexKnowledgePublication(pool: Pool, candidate: KnowledgeDiscoveryCandidate): Promise<void> {
  await withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO search.knowledge_discovery_subject(subject_id,sequence) VALUES ($1,0)
        ON CONFLICT DO NOTHING`,
        [candidate.subjectId],
      );
      const cut = (
        await client.query<{ sequence: string }>(
          'SELECT sequence::text FROM search.knowledge_discovery_subject WHERE subject_id=$1 FOR UPDATE',
          [candidate.subjectId],
        )
      ).rows[0]!;
      const next = (BigInt(cut.sequence) + 1n).toString();
      const inserted = await client.query(
        `INSERT INTO search.knowledge_discovery_association
        (subject_id,document_id,publication_id,revision_id,published_at,sequence)
        VALUES ($1,$2,$3,$4,$5::timestamptz,$6::bigint) ON CONFLICT (subject_id,publication_id) DO NOTHING`,
        [
          candidate.subjectId,
          candidate.documentId,
          candidate.publicationId,
          candidate.revisionId,
          candidate.publishedAt,
          next,
        ],
      );
      if (inserted.rowCount)
        await client.query('UPDATE search.knowledge_discovery_subject SET sequence=$2::bigint WHERE subject_id=$1', [
          candidate.subjectId,
          next,
        ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

export function knowledgeDiscoveryEffect(options: {
  pool: Pool;
  source: () => KnowledgeDiscoverySource;
  deadlineNow: () => number;
}): Effect {
  return {
    name: 'search_knowledge_publication',
    types: ['com.rezics.content.knowledge.publication.changed.v1'],
    async run(event) {
      // The native event catalogue validates these identities before effect dispatch.
      const data = event.data as { action: 'selected' | 'withdrawn'; documentId: string; publicationId: string };
      if (data.action === 'withdrawn') return;
      const candidate = await options
        .source()
        .selected(data.documentId, data.publicationId, { deadline: options.deadlineNow() + 30_000 });
      // Delayed adds cannot select an old publication. Any remaining older rows are nominations only.
      if (candidate) await indexKnowledgePublication(options.pool, candidate);
    },
  };
}
