import { expect, setDefaultTimeout, test } from 'bun:test';
import {
  commitHostedVersionRevision,
  resolveHostedVersionRevision,
  HostedVersionRevisionPointerChangedError,
  type HostedVersionRevisionSnapshot,
} from '../../src/content/hosted-version-revision.ts';
import { routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(360_000);

type Fixture = Awaited<ReturnType<typeof hostedChaptersFixture>>;

async function transaction<T>(fixture: Fixture, work: (tx: any) => Promise<T>): Promise<T> {
  const tx = await fixture.native.pool.connect();
  await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    const value = await work(tx);
    await tx.query('COMMIT');
    return value;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}

async function createCatalogue(fixture: Fixture): Promise<string> {
  const result = await fixture.native.command('/v1/hostedCatalogues', {
    postId: fixture.catalogueId,
    threadId: fixture.threadId,
    placements: [],
  });
  return result.revisionId as string;
}

async function createGeneration<Kind extends 'draft' | 'candidate'>(
  tx: any,
  catalogueId: string,
  generationId: string,
  generationKind: Kind,
  sequence: bigint,
): Promise<HostedVersionRevisionSnapshot<Kind>> {
  const route = routeOf(catalogueId)!;
  await tx.query(
    `INSERT INTO content.hosted_tree_generation(route,catalogue_id,generation_id,generation_kind,head_sequence)
     VALUES ($1,$2,$3,$4,$5)`,
    [route, catalogueId, generationId, generationKind, sequence.toString()],
  );
  await tx.query(
    `INSERT INTO content.hosted_tree_snapshot_version
       (route,catalogue_id,generation_id,sequence,preorder_root_id,chapter_root_id,placement_count,chapter_count)
     VALUES ($1,$2,$3,$4,NULL,NULL,0,0)`,
    [route, catalogueId, generationId, sequence.toString()],
  );
  return { route, catalogueId, generationId, generationKind, sequence };
}

async function advanceGeneration<Kind extends 'draft' | 'candidate'>(
  tx: any,
  snapshot: HostedVersionRevisionSnapshot<Kind>,
  nextSequence: bigint,
): Promise<HostedVersionRevisionSnapshot<Kind>> {
  await tx.query(
    `UPDATE content.hosted_tree_generation SET head_sequence=$4
     WHERE route=$1 AND catalogue_id=$2 AND generation_id=$3`,
    [snapshot.route, snapshot.catalogueId, snapshot.generationId, nextSequence.toString()],
  );
  await tx.query(
    `INSERT INTO content.hosted_tree_snapshot_version
       (route,catalogue_id,generation_id,sequence,preorder_root_id,chapter_root_id,placement_count,chapter_count)
     VALUES ($1,$2,$3,$4,NULL,NULL,0,0)`,
    [snapshot.route, snapshot.catalogueId, snapshot.generationId, nextSequence.toString()],
  );
  return { ...snapshot, sequence: nextSequence };
}

function writeBase<Kind extends 'draft' | 'candidate'>(
  fixture: Fixture,
  revisionId: string,
  snapshot: HostedVersionRevisionSnapshot<Kind>,
  expectedDraftRevisionId: string,
) {
  return {
    revisionId,
    snapshot,
    expectedDraftRevisionId,
    recordedTransactionId: fixture.newOccurrenceId(),
    recordedAt: new Date().toISOString(),
  };
}

test('resolves exact old snapshots, separates draft and publication pointers, and rolls back stale descriptors', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const originalRevisionId = await createCatalogue(fixture);
    const draftGenerationId = fixture.newOccurrenceId();
    const firstDraftRevisionId = fixture.newOccurrenceId();
    const firstDraft = await transaction(fixture, async (tx) => {
      const initial = await createGeneration(tx, fixture.catalogueId, draftGenerationId, 'draft', 0n);
      const committed = await advanceGeneration(tx, initial, 1n);
      await commitHostedVersionRevision(tx, {
        ...writeBase(fixture, firstDraftRevisionId, committed, originalRevisionId),
        revisionKind: 'structure',
      });
      return committed;
    });

    const publicationGenerationId = fixture.newOccurrenceId();
    const publicationRevisionId = fixture.newOccurrenceId();
    await transaction(fixture, async (tx) => {
      const initial = await createGeneration(tx, fixture.catalogueId, publicationGenerationId, 'candidate', 0n);
      const publication = await advanceGeneration(tx, initial, 1n);
      await commitHostedVersionRevision(tx, {
        ...writeBase(fixture, publicationRevisionId, publication, firstDraftRevisionId),
        revisionKind: 'publication',
        expectedPublicationId: null,
      });
    });

    const nextDraftRevisionId = fixture.newOccurrenceId();
    await transaction(fixture, async (tx) => {
      const nextDraft = await advanceGeneration(tx, firstDraft, 2n);
      await commitHostedVersionRevision(tx, {
        ...writeBase(fixture, nextDraftRevisionId, nextDraft, firstDraftRevisionId),
        revisionKind: 'structure',
      });
    });

    await expect(
      resolveHostedVersionRevision(fixture.native.pool, fixture.catalogueId, firstDraftRevisionId),
    ).resolves.toMatchObject({
      kind: 'ordered',
      revisionKind: 'structure',
      snapshot: { generationId: draftGenerationId, generationKind: 'draft', sequence: 1n },
    });
    await expect(
      resolveHostedVersionRevision(fixture.native.pool, fixture.catalogueId, publicationRevisionId),
    ).resolves.toMatchObject({
      kind: 'ordered',
      revisionKind: 'publication',
      sourceRevisionId: firstDraftRevisionId,
      snapshot: { generationId: publicationGenerationId, generationKind: 'candidate', sequence: 1n },
    });
    await expect(
      resolveHostedVersionRevision(fixture.native.pool, fixture.catalogueId, originalRevisionId),
    ).resolves.toMatchObject({ kind: 'compatibility', revisionKind: 'structure' });
    await expect(
      resolveHostedVersionRevision(fixture.native.pool, fixture.newOccurrenceId(), firstDraftRevisionId),
    ).resolves.toEqual({ kind: 'missing' });

    const pointers = await fixture.native.pool.query<{ head_revision_id: string; publication_id: string | null }>(
      `SELECT head_revision_id,publication_id FROM content.hosted_catalogue
       WHERE route=$1 AND catalogue_id=$2`,
      [routeOf(fixture.catalogueId), fixture.catalogueId],
    );
    expect(pointers.rows[0]).toEqual({ head_revision_id: nextDraftRevisionId, publication_id: publicationRevisionId });

    const staleRevisionId = fixture.newOccurrenceId();
    const staleGenerationId = fixture.newOccurrenceId();
    await expect(
      transaction(fixture, async (tx) => {
        const stale = await createGeneration(tx, fixture.catalogueId, staleGenerationId, 'draft', 0n);
        await commitHostedVersionRevision(tx, {
          ...writeBase(fixture, staleRevisionId, stale, firstDraftRevisionId),
          revisionKind: 'structure',
        });
      }),
    ).rejects.toBeInstanceOf(HostedVersionRevisionPointerChangedError);

    const rolledBack = await fixture.native.pool.query<{ revisions: string; descriptors: string }>(
      `SELECT
         (SELECT count(*)::text FROM content.hosted_structure_revision
          WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3) AS revisions,
         (SELECT count(*)::text FROM content.hosted_version_revision
          WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3) AS descriptors`,
      [routeOf(fixture.catalogueId), fixture.catalogueId, staleRevisionId],
    );
    expect(rolledBack.rows[0]).toEqual({ revisions: '0', descriptors: '0' });
    const after = await fixture.native.pool.query(
      `SELECT head_revision_id,publication_id FROM content.hosted_catalogue
       WHERE route=$1 AND catalogue_id=$2`,
      [routeOf(fixture.catalogueId), fixture.catalogueId],
    );
    expect(after.rows).toEqual(pointers.rows);

    await expect(
      transaction(fixture, async (tx) => {
        await tx.query(
          `INSERT INTO content.hosted_structure_revision
             (route,catalogue_id,revision_id,kind,source_revision_id,recorded_transaction_id,created_at)
           VALUES ($1,$2,$3,'structure',NULL,$4,$5)`,
          [routeOf(fixture.catalogueId), fixture.catalogueId, staleRevisionId, fixture.newOccurrenceId(), new Date()],
        );
        await tx.query(
          `INSERT INTO content.hosted_version_revision
             (route,catalogue_id,revision_id,revision_kind,generation_id,generation_kind,sequence)
           VALUES ($1,$2,$3,'structure',$4,'draft',1)`,
          [routeOf(fixture.catalogueId), fixture.catalogueId, staleRevisionId, publicationGenerationId],
        );
      }),
    ).rejects.toThrow();
  } finally {
    await fixture.close();
  }
});
