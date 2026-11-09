import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { routeOf } from '../../src/route/route.ts';
import { canonicalSourceCallAllowance } from '../../src/library/canonical-source-bounds.ts';
import { advanceCanonicalSourceCapture } from '../../src/library/canonical-source-store.ts';
import {
  createNativeLibrarySourceCustody,
  type NativeSourceIdentity,
  type NativeSourceFrontier,
} from '../../src/library/native-source-custody.ts';
import {
  nativeSourceCustodyOperationBound,
  nativeSourceCustodyWorkDimensions,
} from '../../src/library/native-source-custody-bounds.ts';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';

let f: CollectionRulesFixture;
let collectionId: string;
let scope: { identity: NativeSourceIdentity; frontier: NativeSourceFrontier | null };
beforeAll(async () => {
  f = await createCollectionRulesFixture();
  await f.entry(await f.subject('Native capture accounting member'));
  const created = await f.send('POST', '/v1/collections', {
    membershipKind: 'dynamic',
    title: 'Native capture accounting',
    visibility: 'private',
    rule: { filter: { owner: { presence: true } } },
  });
  expect(created.status).toBe(201);
  collectionId = (await created.json()).collection.id;
}, 120_000);
afterAll(async () => {
  await f?.close();
});

test('canonical capture persists its zero-result scope write without spending result bytes on JSON framing', async () => {
  await advanceCanonicalSourceCapture(f.database.pool, {
    route: routeOf(collectionId)!,
    collectionId,
    deadline: Date.now() + 30_000,
    allowance: { reservationId: randomUUID(), ...canonicalSourceCallAllowance() },
  });
  const rows = await f.database.admin.query<typeof scope>(
    `SELECT identity,frontier FROM library.canonical_source_scope WHERE route=$1 AND collection_id=$2`,
    [routeOf(collectionId), collectionId],
  );
  expect(rows.rows).toHaveLength(1);
  scope = rows.rows[0]!;
  expect(scope.identity).toMatchObject({
    collectionId,
    accountId: f.runtime.identity.ordinary.accountId,
    scope: 'private_builtin',
  });
});

test('native capture admits the saved owner source under its independently declared capture-page bound', async () => {
  const result = await createNativeLibrarySourceCustody({ pool: f.database.pool }).capturePage({
    identity: scope.identity,
    frontier: scope.frontier,
    limit: 100,
    deadline: Date.now() + 30_000,
    allowance: {
      reservationId: randomUUID(),
      remaining: nativeSourceCustodyWorkDimensions(nativeSourceCustodyOperationBound('capturePage')),
    },
  });
  expect(result.status, JSON.stringify(result)).toBe('pending');
});
