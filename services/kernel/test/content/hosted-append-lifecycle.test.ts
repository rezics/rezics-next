import { expect, setDefaultTimeout, test } from 'bun:test';
import { appendHostedRootChapter, type HostedCommandDependencies } from '../../src/content/hosted-chapters-commands.ts';
import { hostedAppendDescriptor } from '../../src/content/hosted-chapters-append.ts';
import { hostedReadPlacement } from '../../src/content/hosted-chapters-store.ts';
import {
  pageHostedLifecycleRevisions,
  redactHostedLifecyclePlacements,
  redactHostedLifecycleStream,
  type HostedLifecycleStreamCursor,
} from '../../src/content/hosted-append-lifecycle.ts';
import revisionPage from '../../src/content/hosted-append-lifecycle-revisions.sql';
import placementPage from '../../src/content/hosted-append-lifecycle-placements.sql';
import streamPage from '../../src/content/hosted-append-lifecycle-stream.sql';
import startPurge from '../../src/content/start-post-purge.sql';
import markAuthorErased from '../../src/content/account-erasure-authored-mark.sql';
import disposeItem from '../../src/content/account-erasure-authored-item.sql';
import { newId, routeOf } from '../../src/route/route.ts';
import { accountDeletionRuntime, deletePersona } from '../support/account-deletion.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(360_000);
const context = (idempotencyKey = crypto.randomUUID()) => ({ deadline: Date.now() + 120_000, idempotencyKey });

async function book(prefixLength = 2) {
  const f = await hostedChaptersFixture();
  try {
    const source = await f.native.thread();
    const target = f.target(source);
    const part = f.newOccurrenceId(),
      chapter = f.newOccurrenceId();
    const path = `/v1/hostedCatalogues/${f.catalogueId}`;
    const base = (
      await f.native.command('/v1/hostedCatalogues', {
        postId: f.catalogueId,
        threadId: f.threadId,
        placements: [
          { occurrenceId: part, parentId: null, position: 0, title: 'Private empty part', kind: 'part' },
          { occurrenceId: chapter, parentId: null, position: 1, title: 'Base chapter', kind: 'chapter', target },
        ],
      })
    ).revisionId as string;
    const deps: HostedCommandDependencies = {
      pool: f.native.pool,
      access: f.native.system.access,
      tokens: f.native.system.tokenKeys,
      routeKey: f.native.system.routeKey,
      clock: () => new Date(),
    };
    const appended: string[] = [],
      drafts: string[] = [];
    const firstKey = crypto.randomUUID();
    const firstInput = {
      expectedRevisionId: base,
      occurrenceId: f.newOccurrenceId(),
      title: 'Prefix 0',
      target,
    };
    let head = base;
    for (let i = 0; i < prefixLength; i++) {
      const input =
        i === 0
          ? firstInput
          : {
              expectedRevisionId: head,
              occurrenceId: f.newOccurrenceId(),
              title: `Prefix ${i}`,
              target,
            };
      head = (
        await appendHostedRootChapter(deps, f.native.author.actor, f.catalogueId, input, {
          ...context(i === 0 ? firstKey : undefined),
          requestId: crypto.randomUUID(),
        })
      ).value.revisionId;
      appended.push(input.occurrenceId);
      drafts.push(head);
    }
    const release = (
      await f.native.command(
        `${path}:publish`,
        {
          expectedRevisionId: head,
          expectedPublicationId: null,
          occurrenceIds: [chapter, appended[0]],
        },
        200,
      )
    ).revisionId as string;
    const anchor = { catalogueId: f.catalogueId, authorAccountId: f.native.author.actor.accountId };
    const route = routeOf(f.catalogueId)!;
    const rows = async (table: string) =>
      (
        await f.native.pool.query(
          `SELECT * FROM content.${table} WHERE route=$1 AND catalogue_id=$2 ORDER BY 1,2,3,4`,
          [route, f.catalogueId],
        )
      ).rows;
    const manifest = async () =>
      (
        await f.native.pool.query(
          'SELECT * FROM content.hosted_placement WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3 ORDER BY ordinal',
          [route, f.catalogueId, release],
        )
      ).rows;
    return {
      ...f,
      source,
      target,
      part,
      chapter,
      path,
      base,
      drafts,
      appended,
      release,
      deps,
      anchor,
      route,
      rows,
      manifest,
      firstKey,
      firstInput,
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}

test('terminal native eligibility alone redacts private labels and retains shared bases, exact manifests and identities', async () => {
  const f = await book();
  try {
    const pool = f.native.pool;
    const first = f.drafts[0]!,
      pinned = f.drafts[1]!;
    const descriptor = await hostedAppendDescriptor(pool, f.catalogueId, pinned);
    const originalPrefix = await hostedReadPlacement(pool, f.catalogueId, pinned, f.appended[0]!, descriptor);
    const release = await f.manifest();
    await f.native.command(
      `${f.path}:revise`,
      {
        expectedRevisionId: pinned,
        placements: [],
      },
      200,
    );
    expect(await hostedReadPlacement(pool, f.catalogueId, pinned, f.appended[0]!, descriptor)).toEqual(originalPrefix);
    expect(await hostedAppendDescriptor(pool, f.catalogueId, first)).toMatchObject({
      baseRevisionId: f.base,
      highWater: 0n,
    });
    expect(await f.manifest()).toEqual(release);
    const immutable = await Promise.all(
      ['hosted_catalogue', 'hosted_structure_revision', 'hosted_occurrence', 'hosted_append_descriptor'].map(f.rows),
    );
    const skeleton = (rows: Record<string, unknown>[]) =>
      rows.map(({ title, title_redacted, ...identity }) => identity);
    const originalPlacements = skeleton(await f.rows('hosted_placement'));
    const originalAppends = skeleton(await f.rows('hosted_append'));
    const targetBefore = (
      await pool.query('SELECT * FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY revision_id', [
        routeOf(f.target.postId),
        f.target.postId,
      ])
    ).rows;
    const refuse = () => pageHostedLifecycleRevisions(pool, f.anchor, { afterRevision: null }, context());
    await expect(refuse()).rejects.toThrow('terminal native authority');
    const redactBase = () =>
      pool.query(
        'UPDATE content.hosted_placement SET title=NULL,title_redacted=true WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3',
        [f.route, f.catalogueId, f.base],
      );
    await expect(redactBase()).rejects.toThrow('terminal native authority');
    const deleted = await f.native.system.kernel.handle(
      new Request(`https://content.test/v1/posts/${f.catalogueId}`, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${f.native.author.bearer}`,
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
        },
      }),
    );
    expect(deleted.status).toBe(204);
    await startPurge.run(pool, {
      route: f.route,
      post_id: f.catalogueId,
      at: new Date().toISOString(),
      account_erasure: false,
    });
    await expect(refuse()).rejects.toThrow('terminal native authority');
    await expect(redactBase()).rejects.toThrow('terminal native authority');
    expect(await f.manifest()).toEqual(release);
    // The native eligibility operation, with its existing clock, matures this soft tombstone.
    await startPurge.run(pool, {
      route: f.route,
      post_id: f.catalogueId,
      at: new Date(Date.now() + 31 * 86400000).toISOString(),
      account_erasure: false,
    });
    await expect(
      pageHostedLifecycleRevisions(
        pool,
        { ...f.anchor, authorAccountId: f.native.system.actors.other.actor.accountId },
        { afterRevision: null },
        context(),
      ),
    ).rejects.toThrow('terminal native authority');
    await expect(
      pool.query(
        'UPDATE content.hosted_append SET title=NULL,title_redacted=true,target_revision_id=$3 WHERE route=$1 AND catalogue_id=$2',
        [f.route, f.catalogueId, f.release],
      ),
    ).rejects.toThrow('one-way title redaction');
    const inventory = await pageHostedLifecycleRevisions(pool, f.anchor, { afterRevision: null }, context());
    expect(inventory.value.items.find((r) => r.revisionId === f.base)).toMatchObject({ streamHighWater: '1' });
    expect(inventory.value.items.find((r) => r.revisionId === pinned)).toMatchObject({ streamHighWater: null });
    for (const r of inventory.value.items) {
      const page = await redactHostedLifecyclePlacements(
        pool,
        f.anchor,
        { revisionId: r.revisionId, afterOccurrence: null },
        context(),
      );
      expect(page.value.items.length).toBe(r.revisionId === f.base ? 2 : 0);
    }
    const cursor = { streamId: f.base, highWater: '1', afterOffset: '-1' };
    const page = await redactHostedLifecycleStream(pool, f.anchor, cursor, context());
    expect(page.value.items).toEqual(
      f.appended.map((occurrenceId, i) => ({ occurrenceId, offset: String(i), changed: true })),
    );
    expect(page.value.next).toBeNull();
    expect(
      await Promise.all(
        ['hosted_catalogue', 'hosted_structure_revision', 'hosted_occurrence', 'hosted_append_descriptor'].map(f.rows),
      ),
    ).toEqual(immutable);
    expect(await f.manifest()).toEqual(release);
    expect(skeleton(await f.rows('hosted_placement'))).toEqual(originalPlacements);
    expect(skeleton(await f.rows('hosted_append'))).toEqual(originalAppends);
    expect((await f.rows('hosted_placement')).filter((r) => r.revision_id === f.base)).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: null, title_redacted: true })]),
    );
    await expect(hostedReadPlacement(pool, f.catalogueId, pinned, f.appended[0]!, descriptor)).rejects.toThrow(
      'Redacted hosted placement',
    );
    expect(
      (
        await pool.query('SELECT * FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY revision_id', [
          routeOf(f.target.postId),
          f.target.postId,
        ])
      ).rows,
    ).toEqual(targetBefore);
    for (const sql of [
      'UPDATE content.hosted_placement SET title=NULL,title_redacted=true WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3',
      "UPDATE content.hosted_placement SET title='Fake',title_redacted=false WHERE route=$1 AND catalogue_id=$2 AND revision_id<>$3",
      'UPDATE content.hosted_append SET target_revision_id=$3 WHERE route=$1 AND catalogue_id=$2',
      'UPDATE content.hosted_append_descriptor SET high_water=high_water WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3',
      'DELETE FROM content.hosted_occurrence WHERE route=$1 AND catalogue_id=$2 AND occurrence_id=$3',
      'DELETE FROM content.hosted_placement WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3',
    ])
      await expect(
        pool.query(sql, [f.route, f.catalogueId, sql.includes('occurrence_id=$3') ? f.appended[0] : f.release]),
      ).rejects.toThrow();
    expect(
      (await f.native.call('GET', `${f.path}/children?revisionId=${f.release}`, undefined, { anonymous: true })).status,
    ).toBe(404);
    await expect(
      appendHostedRootChapter(f.deps, f.native.author.actor, f.catalogueId, f.firstInput, {
        ...context(f.firstKey),
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test('retained-published account authority freezes 100-row pages, replay and a late-item continuation without rewriting releases', async () => {
  const f = await book(101);
  const observer = observeSql(f.native.pool);
  try {
    const pool = f.native.pool;
    const published = { id: f.threadId, firstPost: { id: f.catalogueId, revisionId: '' } };
    const current = (
      await pool.query('SELECT head_revision_id FROM content.post WHERE route=$1 AND post_id=$2', [
        f.route,
        f.catalogueId,
      ])
    ).rows[0];
    published.firstPost.revisionId = current.head_revision_id;
    expect((await f.native.revise({ ...published.firstPost, visibility: 'published' }, {})).status).toBe(200);
    const release = await f.manifest();
    const late = await f.native.thread();
    const lateRoute = routeOf(late.firstPost.id)!;
    const lateOccurrence = newId(lateRoute);
    const lateBase = (
      await f.native.command('/v1/hostedCatalogues', {
        postId: late.firstPost.id,
        threadId: late.id,
        placements: [
          { occurrenceId: lateOccurrence, parentId: null, position: 0, title: 'Late private', kind: 'part' },
        ],
      })
    ).revisionId as string;
    const lateAnchor = { ...f.anchor, catalogueId: late.firstPost.id };
    const runtime = accountDeletionRuntime(f.native.system);
    await deletePersona(
      { version: 1, pool, auth: runtime.auth },
      {
        accountId: f.anchor.authorAccountId,
        bearer: f.native.author.bearer,
      },
    );
    // The existing account participant owns the obligation and installs this local
    // authority before hosted receiving. Its workflow/acknowledgement is separate.
    await markAuthorErased.run(pool, {
      route: f.route,
      account_id: f.anchor.authorAccountId,
      item_kind: 'post',
      item_id: f.catalogueId,
    });
    await disposeItem.run(pool, {
      route: f.route,
      account_id: f.anchor.authorAccountId,
      item_kind: 'post',
      item_id: f.catalogueId,
      after_at: '-infinity',
      after_revision: '00000000-0000-0000-0000-000000000000',
      revision_limit: 100,
    });
    const inventoryKey = context();
    const inventory = await pageHostedLifecycleRevisions(pool, f.anchor, { afterRevision: null }, inventoryKey);
    expect(inventory.value.items).toHaveLength(100);
    expect(inventory.value.next).not.toBeNull();
    const tail = await pageHostedLifecycleRevisions(pool, f.anchor, inventory.value.next!, context());
    expect(tail.value.next).toBeNull();
    const all = [...inventory.value.items, ...tail.value.items];
    expect(all).toHaveLength(103);
    expect(all.filter((r) => r.streamHighWater !== null)).toEqual([
      expect.objectContaining({ revisionId: f.base, streamHighWater: '100' }),
    ]);
    expect((await pageHostedLifecycleRevisions(pool, f.anchor, { afterRevision: null }, inventoryKey)).value).toEqual(
      inventory.value,
    );
    const cursor: HostedLifecycleStreamCursor = { streamId: f.base, highWater: '100', afterOffset: '-1' };
    const firstKey = context();
    const first = await redactHostedLifecycleStream(pool, f.anchor, cursor, firstKey);
    expect(first.value.items).toHaveLength(100);
    expect(first.value.items.every((r) => r.changed)).toBe(true);
    expect(first.value.next).toEqual({ ...cursor, afterOffset: '99' });
    expect(await redactHostedLifecycleStream(pool, f.anchor, cursor, firstKey)).toMatchObject({
      replayed: true,
      value: first.value,
    });
    await expect(redactHostedLifecycleStream(pool, f.anchor, { ...cursor, highWater: '99' }, firstKey)).rejects.toThrow(
      'Idempotency',
    );
    const duplicate = await redactHostedLifecycleStream(pool, f.anchor, cursor, context());
    expect(duplicate.value.items.every((r) => !r.changed)).toBe(true);
    expect(duplicate.value.next).toEqual(first.value.next);
    await expect(pageHostedLifecycleRevisions(pool, lateAnchor, { afterRevision: null }, context())).rejects.toThrow(
      'terminal native authority',
    );
    await markAuthorErased.run(pool, {
      route: lateRoute,
      account_id: f.anchor.authorAccountId,
      item_kind: 'post',
      item_id: late.firstPost.id,
    });
    const latePage = await redactHostedLifecyclePlacements(
      pool,
      lateAnchor,
      { revisionId: lateBase, afterOccurrence: null },
      context(),
    );
    expect(latePage.value.items).toEqual([{ occurrenceId: lateOccurrence, changed: true }]);
    // Resume the saved cursor after an independent late item's disposition.
    const last = await redactHostedLifecycleStream(pool, f.anchor, first.value.next!, context());
    expect(last.value.items).toEqual([{ occurrenceId: f.appended[100]!, offset: '100', changed: true }]);
    expect(last.value.next).toBeNull();
    const exhausted = await redactHostedLifecycleStream(pool, f.anchor, { ...cursor, afterOffset: '100' }, context());
    expect(exhausted.value).toEqual({ items: [], next: null });
    await redactHostedLifecyclePlacements(pool, f.anchor, { revisionId: f.base, afterOccurrence: null }, context());
    expect(await f.manifest()).toEqual(release);
    const bodies = (
      await pool.query('SELECT revision_id,body,availability FROM content.revision WHERE route=$1 AND post_id=$2', [
        f.route,
        f.catalogueId,
      ])
    ).rows;
    expect(bodies.find((r) => r.revision_id === current.head_revision_id)).toMatchObject({
      body: null,
      availability: 'erased',
    });
    expect(bodies.filter((r) => r.body !== null)).toHaveLength(1);
    expect((await f.rows('hosted_append')).every((r) => r.title === null && r.title_redacted)).toBe(true);
    expect((await f.native.call('GET', `${f.path}/children?kind=structure`)).status).not.toBe(200);
    expect(
      (await f.native.call('GET', `${f.path}/children?revisionId=${f.release}`, undefined, { anonymous: true })).status,
    ).toBe(200);
    const rangeStatements = new Set<string>([revisionPage.sql, placementPage.sql, streamPage.sql]);
    const ranges = observer.records.filter((r) => rangeStatements.has(r.statement));
    expect(ranges.length).toBeGreaterThan(0);
    expect(
      ranges.every((r) => r.statement.includes('LIMIT 100') && !/OFFSET |COUNT\(|WITH RECURSIVE/i.test(r.statement)),
    ).toBe(true);
    expect(ranges.filter((r) => r.statement === streamPage.sql)).toHaveLength(4);
  } finally {
    await observer.close();
    await f.close();
  }
});
