import type { Pool, PoolClient } from 'pg';
import { newId, routeOf } from '../../../src/route/route.ts';
import { orderHostedPlacements, selectHostedRelease } from '../../../src/content/hosted-chapters-tree.ts';
import { ensureHostedOccurrenceIdentities } from '../../../src/content/hosted-chapters-store.ts';
import { hostedAppendDescriptor } from '../../../src/content/hosted-chapters-append.ts';
import { hostedReleasePlacements, hostedReadPlacementPage } from '../../../src/content/hosted-maintenance-manifest.ts';
import type {
  HostedPlacement,
  HostedChapterTarget,
  OrderedHostedPlacement,
} from '../../../src/content/hosted-chapters-model.ts';
import type { HostedVersionSnapshot } from '../../../src/content/hosted-version-model.ts';

type Fixture = Readonly<{ native: { pool: Pool }; catalogueId: string; threadId: string }>;

/** Explicit persisted-data setup for one-time maintenance/reference tests. Source Posts and Access identities
 * are created by the ordinary native fixture. These helpers never stand in for public authoring acceptance. */
export function retainedHostedData(fixture: Fixture) {
  const { catalogueId, threadId } = fixture;
  const route = routeOf(catalogueId)!;
  async function transaction<T>(action: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await fixture.native.pool.connect();
    try {
      await tx.query('BEGIN');
      const value = await action(tx);
      await tx.query('COMMIT');
      return value;
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      tx.release();
    }
  }
  async function header(tx: PoolClient, revisionId: string, kind: 'structure' | 'publication', source: string | null) {
    await tx.query(
      `INSERT INTO content.hosted_structure_revision
      (route,catalogue_id,revision_id,kind,source_revision_id,recorded_transaction_id,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())`,
      [route, catalogueId, revisionId, kind, source, newId(route)],
    );
  }
  async function manifest(tx: PoolClient, revisionId: string, placements: readonly OrderedHostedPlacement[]) {
    await ensureHostedOccurrenceIdentities(tx, catalogueId, placements);
    if (!placements.length) return;
    await tx.query(
      `INSERT INTO content.hosted_placement
      (route,catalogue_id,revision_id,occurrence_id,parent_id,position,ordinal,title,target_revision_id,body_sha256)
      SELECT $1,$2,$3,item.occurrence_id,item.parent_id,item.position,item.ordinal,item.title,item.revision_id,decode(item.sha256,'hex')
      FROM jsonb_to_recordset($4::jsonb) item(occurrence_id uuid,parent_id uuid,position integer,ordinal integer,title text,revision_id uuid,sha256 text)`,
      [
        route,
        catalogueId,
        revisionId,
        JSON.stringify(
          placements.map((placement) => ({
            occurrence_id: placement.occurrenceId,
            parent_id: placement.parentId,
            position: placement.position,
            ordinal: placement.ordinal,
            title: placement.title,
            revision_id: placement.target?.revisionId ?? null,
            sha256: placement.target?.sha256 ?? null,
          })),
        ),
      ],
    );
  }
  return {
    async children(revisionId: string) {
      return transaction(async (tx) =>
        hostedReadPlacementPage(
          tx,
          catalogueId,
          revisionId,
          { mode: 'children', parentId: null, after: -1, limit: 20 },
          await hostedAppendDescriptor(tx, catalogueId, revisionId),
        ),
      );
    },
    async adoptPublication(publicationId: string, snapshot: HostedVersionSnapshot) {
      if (snapshot.catalogueId !== catalogueId || snapshot.generationKind !== 'candidate')
        throw new Error('Retained fixture publication snapshot mismatch');
      await transaction(async (tx) => {
        const adopted = await tx.query(
          `INSERT INTO content.hosted_version_revision
          (route,catalogue_id,revision_id,revision_kind,generation_id,generation_kind,sequence)
          SELECT $1,$2,$3,'publication',$4,'candidate',$5::bigint
          WHERE EXISTS(SELECT 1 FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2 AND publication_id=$3)
          AND EXISTS(SELECT 1 FROM content.hosted_structure_revision WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3 AND kind='publication')
          RETURNING revision_id`,
          [route, catalogueId, publicationId, snapshot.generationId, snapshot.sequence.toString()],
        );
        if (adopted.rows.length !== 1)
          throw new Error('Retained publication changed before maintenance descriptor adoption');
      });
    },
    async structure(input: readonly unknown[]) {
      const placements = orderHostedPlacements(route, input as readonly HostedPlacement[]);
      const revisionId = newId(route);
      await transaction(async (tx) => {
        await tx.query(
          `INSERT INTO content.hosted_catalogue(route,catalogue_id,thread_id,head_revision_id)
          VALUES ($1,$2,$3,$4) ON CONFLICT (route,catalogue_id) DO NOTHING`,
          [route, catalogueId, threadId, revisionId],
        );
        await header(tx, revisionId, 'structure', null);
        await manifest(tx, revisionId, placements);
        await tx.query('UPDATE content.hosted_catalogue SET head_revision_id=$3 WHERE route=$1 AND catalogue_id=$2', [
          route,
          catalogueId,
          revisionId,
        ]);
      });
      return { catalogueId, revisionId };
    },
    async append(
      input: Readonly<{ expectedRevisionId: string; occurrenceId: string; title: string; target: HostedChapterTarget }>,
    ) {
      const revisionId = newId(route);
      await transaction(async (tx) => {
        const current = (
          await tx.query<{ head_revision_id: string }>(
            'SELECT head_revision_id FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2 FOR UPDATE',
            [route, catalogueId],
          )
        ).rows[0];
        if (current?.head_revision_id !== input.expectedRevisionId) throw new Error('Retained fixture head changed');
        let descriptor = await hostedAppendDescriptor(tx, catalogueId, input.expectedRevisionId);
        if (!descriptor) {
          const maximum = (
            await tx.query<{ placements: string; roots: string }>(
              `SELECT
            COALESCE((SELECT ordinal+1 FROM content.hosted_placement WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3 ORDER BY ordinal DESC LIMIT 1),0)::text AS placements,
            COALESCE((SELECT position+1 FROM content.hosted_placement WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3 AND parent_id IS NULL ORDER BY position DESC LIMIT 1),0)::text AS roots`,
              [route, catalogueId, input.expectedRevisionId],
            )
          ).rows[0]!;
          descriptor = {
            revisionId: input.expectedRevisionId,
            baseRevisionId: input.expectedRevisionId,
            basePlacementCount: BigInt(maximum.placements),
            baseRootCount: BigInt(maximum.roots),
            highWater: -1n,
          };
          await tx.query(
            `INSERT INTO content.hosted_append_descriptor(route,catalogue_id,revision_id,base_revision_id,base_placement_count,base_root_count,high_water)
            VALUES ($1,$2,$3,$3,$4,$5,-1)`,
            [route, catalogueId, input.expectedRevisionId, maximum.placements, maximum.roots],
          );
        }
        const offset = descriptor.highWater + 1n;
        await header(tx, revisionId, 'structure', null);
        await ensureHostedOccurrenceIdentities(
          tx,
          catalogueId,
          orderHostedPlacements(route, [{ ...input, parentId: null, position: 0, kind: 'chapter' }]),
        );
        await tx.query(
          `INSERT INTO content.hosted_append(route,catalogue_id,stream_id,append_offset,revision_id,occurrence_id,title,target_revision_id,body_sha256)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,decode($9,'hex'))`,
          [
            route,
            catalogueId,
            descriptor.baseRevisionId,
            offset.toString(),
            revisionId,
            input.occurrenceId,
            input.title,
            input.target.revisionId,
            input.target.sha256,
          ],
        );
        await tx.query(
          `INSERT INTO content.hosted_append_descriptor(route,catalogue_id,revision_id,base_revision_id,base_placement_count,base_root_count,high_water)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            route,
            catalogueId,
            revisionId,
            descriptor.baseRevisionId,
            descriptor.basePlacementCount.toString(),
            descriptor.baseRootCount.toString(),
            offset.toString(),
          ],
        );
        await tx.query('UPDATE content.hosted_catalogue SET head_revision_id=$3 WHERE route=$1 AND catalogue_id=$2', [
          route,
          catalogueId,
          revisionId,
        ]);
      });
      return { value: { catalogueId, revisionId } };
    },
    async publication(expectedRevisionId: string, occurrenceIds: readonly string[]) {
      const revisionId = newId(route);
      await transaction(async (tx) => {
        const selected = selectHostedRelease(
          await hostedReleasePlacements(tx, catalogueId, expectedRevisionId, occurrenceIds),
          occurrenceIds,
        );
        await header(tx, revisionId, 'publication', expectedRevisionId);
        await manifest(tx, revisionId, selected);
        await tx.query('UPDATE content.hosted_catalogue SET publication_id=$3 WHERE route=$1 AND catalogue_id=$2', [
          route,
          catalogueId,
          revisionId,
        ]);
      });
      return { catalogueId, revisionId };
    },
  };
}
