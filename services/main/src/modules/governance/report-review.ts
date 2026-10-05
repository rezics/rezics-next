import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import { reviewVisibleSql } from '../review/store.ts';
import { RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { publicWork } from '../work/public-patterns.ts';
import { type CapturedEvidence, type DecisionTargetInput, type EvidenceTarget,
  GovernanceDenied, GovernanceInvalid, GovernanceStale, sha256 } from './store.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The report owner captures exactly the current immutable review revision.
 * Governance and reviews share Access, so decision CAS and enforcement commit
 * in one transaction, with the review head row locked against concurrent edits. */
export class ReviewReportOwner {
  constructor(private readonly pool: Pool,
    private readonly access: Pick<AccessAdmissionRegistry, 'canReadWork'>,
    private readonly env: WorkActivationEnvironment) {}

  async capture(principal: VerifiedPrincipal, actingSubject: string,
    target: EvidenceTarget): Promise<CapturedEvidence> {
    if (target.owner !== 'review' || target.component !== 'body'
      || !uuid.test(target.resource) || !target.revision || !uuid.test(target.revision)
      || target.locator !== null) throw new GovernanceInvalid('review evidence needs an exact body revision');
    const row = (await this.pool.query<{ work: string; context: string; realm: string | null;
      revision: string; body: string; language: string; spoiler: boolean;
      rating_revision: string; deleted: boolean }>(`
      SELECT r.work, r.context, r.realm, v.revision::text, v.body, v.language, v.spoiler,
        v.rating_revision, v.deleted
      FROM access.reader_review r JOIN access.authority_subject s
        ON s.id = r.acting_subject AND s.active
      JOIN access.reader_review_revision v
        ON v.review_id = r.id AND v.revision = $2::uuid
      WHERE r.id = $1::uuid AND NOT r.deleted
        AND ${reviewVisibleSql}`, [target.resource, target.revision])).rows[0];
    if (!row || row.deleted) throw new GovernanceDenied('reported review is unavailable');
    const permitted = await this.access.canReadWork(principal, actingSubject, row.work);
    const publicRows = !permitted ? (await this.env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/> SELECT DISTINCT ?main WHERE {
        ${publicWork(iri(row.work), '?main')}
      } LIMIT 2`, 16_384)).results?.bindings ?? [] : [];
    if (!permitted && publicRows.length !== 1) {
      throw new GovernanceDenied('reporter cannot read the reviewed Work');
    }
    return { ...target, state: 'available', representation: 'reader-review-v1',
      revisionDigest: sha256(JSON.stringify([target.resource, row.revision, row.body,
        row.language, row.spoiler, row.rating_revision])),
      provenance: { capturedBy: 'review-exact-read-v1', context: row.context,
        ...(row.realm ? { realm: row.realm } : {}) } };
  }

  async current(target: { owner: string; resource: string; component: string }): Promise<string | null> {
    if (target.owner !== 'review' || target.component !== 'body' || !uuid.test(target.resource)) return null;
    const row = (await this.pool.query<{ revision: string }>(`
      SELECT revision::text FROM access.reader_review WHERE id = $1 AND NOT deleted`,
    [target.resource])).rows[0];
    return row?.revision ?? null;
  }

  async lockCurrent(client: PoolClient, target: DecisionTargetInput): Promise<void> {
    if (target.owner !== 'review' || target.component !== 'body'
      || !uuid.test(target.resource) || !['disclosure', 'publication'].includes(target.effect)
      || target.locator !== null) throw new GovernanceInvalid('invalid review moderation target');
    const row = (await client.query<{ revision: string }>(`
      SELECT revision::text FROM access.reader_review WHERE id = $1 AND NOT deleted FOR UPDATE`,
    [target.resource])).rows[0];
    if (!row || row.revision !== target.expectedHead
      || target.revision !== null && target.revision !== row.revision) {
      throw new GovernanceStale('review head changed since evidence capture');
    }
  }

  async bumpCollection(client: PoolClient, review: string): Promise<void> {
    await client.query(`UPDATE access.reader_review_collection c SET revision = gen_random_uuid()
      FROM access.reader_review r WHERE r.id = $1 AND c.context = r.context AND c.work = r.work`, [review]);
  }

  async visible(client: PoolClient, review: string): Promise<boolean> {
    const row = (await client.query<{ visible: boolean }>(`SELECT NOT r.deleted AND
      access.reader_review_rank_visible(r.id, r.revision, r.context, r.realm) AS visible
      FROM access.reader_review r WHERE r.id = $1`, [review])).rows[0];
    return row?.visible ?? false;
  }

  async rankChanged(client: PoolClient, review: string, before: boolean): Promise<void> {
    const row = (await client.query<{ work: string; created_at: Date; visible: boolean }>(`
      SELECT r.work, r.created_at, NOT r.deleted AND access.reader_review_rank_visible(
        r.id, r.revision, r.context, r.realm) AS visible
      FROM access.reader_review r WHERE r.id = $1`, [review])).rows[0];
    if (row && before !== row.visible) {
      await client.query('SELECT access.append_reader_review_rank_change($1,$2,$3)',
        [row.work, row.created_at, row.visible ? 1 : -1]);
    }
  }

}
