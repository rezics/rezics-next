import { expect, setDefaultTimeout, test } from 'bun:test';
import { eraseAccountAuthoredItem, eraseAccountAuthoredPage } from '../../src/content/account-erasure-authored.ts';
import { appendHostedRootChapter, type HostedCommandDependencies } from '../../src/content/hosted-chapters-commands.ts';
import { accountDeletionRuntime, deletePersona, drainEffects } from '../support/account-deletion.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(180_000);

test('account erasure clears private hosted titles before locator acknowledgement and replays late items', async () => {
  const f = await hostedChaptersFixture();
  try {
    const pool = f.native.pool;
    const catalogueRoute = routeOf(f.catalogueId)!;
    const authorId = f.native.author.actor.accountId;
    const source = await f.native.thread();
    const target = f.target(source);
    const path = `/v1/hostedCatalogues/${f.catalogueId}`;
    const baseOccurrence = f.newOccurrenceId();
    const base = await f.native.command('/v1/hostedCatalogues', {
      postId: f.catalogueId,
      threadId: f.threadId,
      placements: [
        {
          occurrenceId: baseOccurrence,
          parentId: null,
          position: 0,
          title: 'Published account label',
          kind: 'chapter',
          target,
        },
      ],
    });
    const release = await f.native.command(
      `${path}:publish`,
      {
        expectedRevisionId: base.revisionId,
        expectedPublicationId: null,
        occurrenceIds: [baseOccurrence],
      },
      200,
    );
    const dependencies: HostedCommandDependencies = {
      pool,
      access: f.native.system.access,
      tokens: f.native.system.tokenKeys,
      routeKey: f.native.system.routeKey,
      clock: () => new Date(),
    };
    let head = base.revisionId;
    for (const title of ['Private account append one', 'Private account append two']) {
      const appended = await appendHostedRootChapter(
        dependencies,
        f.native.author.actor,
        f.catalogueId,
        { expectedRevisionId: head, occurrenceId: f.newOccurrenceId(), title, target },
        { idempotencyKey: crypto.randomUUID(), deadline: Date.now() + 120_000, requestId: crypto.randomUUID() },
      );
      head = appended.value.revisionId;
    }
    const beforeRevision = await pool.query<{ head_revision_id: string }>(
      'SELECT head_revision_id::text FROM content.post WHERE route=$1 AND post_id=$2',
      [catalogueRoute, f.catalogueId],
    );
    await f.native.revise({ id: f.catalogueId, revisionId: beforeRevision.rows[0]!.head_revision_id }, {});
    const current = await pool.query<{ head_revision_id: string }>(
      'SELECT head_revision_id::text FROM content.post WHERE route=$1 AND post_id=$2',
      [catalogueRoute, f.catalogueId],
    );
    const revisionsBefore = await pool.query(
      `SELECT revision_id::text,body IS NOT NULL AS has_body
       FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY recorded_at,revision_id`,
      [catalogueRoute, f.catalogueId],
    );
    expect(revisionsBefore.rows.length).toBeGreaterThan(1);
    const releaseBefore = (
      await pool.query(
        `SELECT p.revision_id::text,p.occurrence_id::text,p.parent_id::text,p.position,p.ordinal,p.title,
                p.target_revision_id::text,encode(p.body_sha256,'hex') AS digest
         FROM content.hosted_placement p JOIN content.hosted_structure_revision r
           ON r.route=p.route AND r.catalogue_id=p.catalogue_id AND r.revision_id=p.revision_id
         WHERE p.route=$1 AND p.catalogue_id=$2 AND r.kind='publication' ORDER BY p.ordinal`,
        [catalogueRoute, f.catalogueId],
      )
    ).rows;

    await pool.query(
      `INSERT INTO content.author_item(route,author_account_id,item_kind,item_id,thread_id,thread_kind,
                                       created_at,source_epoch,source_position)
       SELECT p.route,p.author_account_id,'post',p.post_id,p.thread_id,t.kind,t.created_at,1,1
       FROM content.post p JOIN content.thread t USING(route,thread_id)
       WHERE p.route=$1 AND p.post_id=$2`,
      [catalogueRoute, f.catalogueId],
    );
    const deletion = accountDeletionRuntime(f.native.system);
    await deletePersona(
      { version: 1, pool, auth: deletion.auth },
      { accountId: authorId, bearer: f.native.author.bearer },
    );
    await drainEffects(pool, partitionOf(routeOf(authorId)!));

    const page = await eraseAccountAuthoredPage({ pool }, authorId, null);
    expect(page.next).toBeNull();
    expect(
      (
        await pool.query('SELECT 1 FROM content.author_item WHERE route=$1 AND author_account_id=$2', [
          routeOf(authorId),
          authorId,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pool.query(
          `SELECT p.title,p.title_redacted,r.kind
           FROM content.hosted_placement p JOIN content.hosted_structure_revision r
             ON r.route=p.route AND r.catalogue_id=p.catalogue_id AND r.revision_id=p.revision_id
           WHERE p.route=$1 AND p.catalogue_id=$2 ORDER BY r.kind,p.ordinal`,
          [catalogueRoute, f.catalogueId],
        )
      ).rows.filter((row) => row.kind === 'structure'),
    ).toEqual([{ title: null, title_redacted: true, kind: 'structure' }]);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM content.hosted_append
           WHERE route=$1 AND catalogue_id=$2 AND title IS NULL AND title_redacted`,
          [catalogueRoute, f.catalogueId],
        )
      ).rows[0]?.count,
    ).toBe(2);
    expect(
      (
        await pool.query(
          `SELECT p.revision_id::text,p.occurrence_id::text,p.parent_id::text,p.position,p.ordinal,p.title,
                  p.target_revision_id::text,encode(p.body_sha256,'hex') AS digest
           FROM content.hosted_placement p JOIN content.hosted_structure_revision r
             ON r.route=p.route AND r.catalogue_id=p.catalogue_id AND r.revision_id=p.revision_id
           WHERE p.route=$1 AND p.catalogue_id=$2 AND r.kind='publication' ORDER BY p.ordinal`,
          [catalogueRoute, f.catalogueId],
        )
      ).rows,
    ).toEqual(releaseBefore);
    const revisionsAfter = await pool.query(
      `SELECT revision_id::text,body IS NOT NULL AS has_body
       FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY recorded_at,revision_id`,
      [catalogueRoute, f.catalogueId],
    );
    expect(revisionsAfter.rows.filter((row) => row.has_body)).toHaveLength(1);
    expect(revisionsAfter.rows.find((row) => row.has_body)?.revision_id).toBe(current.rows[0]!.head_revision_id);
    expect(revisionsAfter.rows).toHaveLength(revisionsBefore.rows.length);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS remaining
           FROM content.hosted_placement p JOIN content.hosted_structure_revision r
             ON r.route=p.route AND r.catalogue_id=p.catalogue_id AND r.revision_id=p.revision_id
           WHERE p.route=$1 AND p.catalogue_id=$2 AND r.kind='structure' AND p.title IS NOT NULL`,
          [catalogueRoute, f.catalogueId],
        )
      ).rows[0]?.remaining,
    ).toBe(0);

    // A delayed author-item projection is disposed by the same native path
    // before its locator is removed; duplicate delivery is harmless.
    await pool.query(
      `INSERT INTO content.author_item(route,author_account_id,item_kind,item_id,thread_id,thread_kind,
                                       created_at,source_epoch,source_position)
       SELECT p.route,p.author_account_id,'post',p.post_id,p.thread_id,t.kind,t.created_at,2,2
       FROM content.post p JOIN content.thread t USING(route,thread_id)
       WHERE p.route=$1 AND p.post_id=$2`,
      [catalogueRoute, f.catalogueId],
    );
    await eraseAccountAuthoredItem({ pool }, authorId, 'post', f.catalogueId);
    await eraseAccountAuthoredItem({ pool }, authorId, 'post', f.catalogueId);
    expect(
      (
        await pool.query('SELECT 1 FROM content.author_item WHERE route=$1 AND author_account_id=$2', [
          routeOf(authorId),
          authorId,
        ])
      ).rows,
    ).toEqual([]);
    expect(release.revisionId).toBeTruthy();
  } finally {
    await f.close();
  }
});
