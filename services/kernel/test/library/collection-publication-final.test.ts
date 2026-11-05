import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { createCurrentConsentReader } from '../../../auth/src/current-consent.ts';
import type { CurrentConsentReader } from '../../src/request/auth-consent.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import {
  beginCollectionSourceOutput,
  type CollectionOutputRef,
  completeCollectionSourceOutput,
} from '../../src/library/collection-source-output.ts';
import {
  createCollectionPublicationEpisodes,
  readCollectionPublicationEpisode,
} from '../../src/library/collection-publication-episodes.ts';
import {
  createCollectionPublicationFinalActivation,
  readCollectionPublicationFinalResult,
} from '../../src/library/collection-publication-final.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { identitySupport } from '../imports/identity-fixture.ts';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';

let f: CollectionRulesFixture;
let actor: AccountActor;
const scopes = [
  'collection:create',
  'collection:read',
  'collection:update',
  'collection:delete',
  'subject:read',
  'library_entry:read',
  'library_entry:list',
  'progress_session:read',
  'progress_session:list',
  'copy:read',
  'copy:list',
];

beforeAll(async () => {
  f = await createCollectionRulesFixture();
  const support = identitySupport(f.runtime.identity);
  const clientId = `publication-final-${randomUUID()}`;
  await f.runtime.identity.auth.internal.registerClient({ clientId, firstParty: true, scopes });
  const signed = await support.request('/signin', {
    email: 'ordinary@identity.test',
    password: 'private native identity fixture password',
    client_id: clientId,
    scope: scopes,
  });
  expect(signed.status).toBe(200);
  const issued = await support.request(
    '/token',
    {},
    new Headers({
      cookie: signed.headers
        .getSetCookie()
        .map((value) => value.split(';')[0]!)
        .join('; '),
    }),
  );
  expect(issued.status).toBe(200);
  const bearer = ((await issued.json()) as { access_token: string }).access_token;
  actor = await f.runtime.identity.access.authenticate(bearer, {
    pool: f.database.pool,
    deadline: Date.now() + 30000,
  });
}, 120000);

afterAll(async () => {
  await f?.close();
});

const episodes = () =>
  createCollectionPublicationEpisodes({ pool: f.database.pool, access: f.runtime.identity.access });

async function pendingWithSelectedA() {
  const subject = await f.subject('Private whole-query source');
  await f.entry(subject);
  const created = await f.send('POST', '/v1/collections', {
    title: 'Private whole-query source',
    visibility: 'private',
    membershipKind: 'dynamic',
    rule: { filter: { owner: { presence: true } }, sort: 'id' },
  });
  expect(created.status).toBe(201);
  const { collection } = (await created.json()) as { collection: { id: string; revision: number } };
  const route = routeOf(collection.id)!;
  const exposed = await f.send('PATCH', `/v1/collections/${collection.id}`, {
    revision: collection.revision,
    visibility: 'public',
  });
  expect(exposed.status).toBe(200);
  const exposure = (await exposed.json()) as { collection: { revision: number } };
  const a: CollectionOutputRef = { route, collectionId: collection.id, generation: randomUUID() };
  const deadline = Date.now() + 30000;
  await runCommand(
    f.database.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline,
      receipt: {
        kind: 'library.collection.publication-final-test-output',
        key: randomUUID(),
        digest: createHash('sha256').update(JSON.stringify(a)).digest(),
      },
      authorization: resourceAuthorization({
        access: f.runtime.identity.access,
        actor,
        action: 'collection:update',
        anchor: {
          resource: { route, id: collection.id },
          async validate(client) {
            return (
              (
                await client.query(
                  `SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2
                   AND curator_account_id=$3 AND state='active' AND membership_kind='dynamic'
                   AND visibility<>'private'`,
                  [route, collection.id, actor.accountId],
                )
              ).rows.length === 1
            );
          },
        },
        context: { pool: f.database.pool, partition: partitionOf(route), deadline },
      }),
    },
    async (tx) => {
      await beginCollectionSourceOutput(tx, { ...a, expectedMembers: 0 });
      await completeCollectionSourceOutput(tx, a);
      return {
        value: a,
        events: [
          {
            type: 'com.rezics.library.collection.updated.v1',
            subject: collection.id,
            data: { collectionId: collection.id },
          },
        ],
      };
    },
  );
  const begun = await episodes().begin(
    actor,
    { collectionId: collection.id, revision: exposure.collection.revision, visibility: 'unlisted' },
    randomUUID(),
  );
  return {
    collectionId: collection.id,
    route,
    a,
    revision: exposure.collection.revision,
    locator: begun.value.locator,
  };
}

function finalActivation(readConsent?: CurrentConsentReader) {
  const support = identitySupport(f.runtime.identity);
  const consent = createCurrentConsentReader({ database: support.authDatabase.pool });
  return createCollectionPublicationFinalActivation({
    workContext: {
      pool: f.database.pool,
      clock: () => new Date(),
      getAuthorization: () => ({
        access: f.runtime.identity.access,
        readConsent:
          readConsent ?? (({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId })),
      }),
    },
  });
}

async function outputState(collectionId: string) {
  const route = routeOf(collectionId)!;
  const collection = (
    await f.database.pool.query(
      `SELECT visibility,revision,source_generation::text AS "sourceGeneration"
       FROM library.collection WHERE route=$1 AND collection_id=$2`,
      [route, collectionId],
    )
  ).rows[0];
  const generations = (
    await f.database.pool.query(
      `SELECT generation::text,state,output_mode,expected_members::text AS "expectedMembers",
              written_members::text AS "writtenMembers"
       FROM library.collection_source_output WHERE route=$1 AND collection_id=$2 ORDER BY generation LIMIT 3`,
      [route, collectionId],
    )
  ).rows;
  const selected =
    (
      await f.database.pool.query(
        `SELECT generation::text,source_generation::text AS "sourceGeneration"
         FROM library.collection_source_output_head WHERE route=$1 AND collection_id=$2`,
        [route, collectionId],
      )
    ).rows[0] ?? null;
  return { collection, generations, selected };
}

test('Whole-query activation restores the original real initiator at each command time and selects only actual complete B atomically without leaking private working authority', async () => {
  const pending = await pendingWithSelectedA();
  const before = await outputState(pending.collectionId);
  expect(before.selected?.generation).toBe(pending.a.generation);
  expect(before.generations).toHaveLength(2);
  expect(before.generations.find((row) => row.generation !== pending.a.generation)).toMatchObject({
    state: 'building',
    output_mode: 'whole_query',
    expectedMembers: null,
    writtenMembers: '0',
  });
  const episode = await readCollectionPublicationEpisode(f.database.pool, pending.locator);
  expect(episode?.phase).toBe('staging');
  expect(episode?.selected?.ref).toEqual(pending.a);

  const support = identitySupport(f.runtime.identity);
  const consent = createCurrentConsentReader({ database: support.authDatabase.pool });
  let currentConsent = true;
  let consentReads = 0;
  let authorizationLoads = 0;
  const activate = createCollectionPublicationFinalActivation({
    workContext: {
      pool: f.database.pool,
      clock: () => new Date(),
      getAuthorization() {
        authorizationLoads++;
        return {
          access: f.runtime.identity.access,
          async readConsent(input) {
            consentReads++;
            return currentConsent
              ? consent.readCurrentConsent({ actorAccountId: input.actorAccountId, clientId: input.clientId })
              : null;
          },
        };
      },
    },
  });
  const requestKey = randomUUID();

  // The foreign publication-work admission/getter is still unavailable here. Its missing seal must
  // refuse activation instead of treating a pending phase or the maintained zero counter as completion.
  await expect(activate.activate(pending.locator, requestKey)).rejects.toMatchObject({
    code: 'dependency_unavailable',
  });
  const afterUnsealed = await outputState(pending.collectionId);
  expect(afterUnsealed).toEqual(before);
  expect(await readCollectionPublicationFinalResult(f.database.pool, pending.locator)).toBeNull();

  // Reusing the same request key still rebuilds restoration at a fresh command time and checks current consent.
  currentConsent = false;
  await expect(activate.activate(pending.locator, requestKey)).rejects.toMatchObject({
    name: 'DurableInitiatorUnavailableError',
  });
  expect(authorizationLoads).toBe(2);
  expect(consentReads).toBeGreaterThanOrEqual(2);
  expect(await outputState(pending.collectionId)).toEqual(before);
}, 120000);

test('a changed pinned rule refuses pending B while the real selected A and retained outputs remain untouched', async () => {
  const pending = await pendingWithSelectedA();
  const before = await outputState(pending.collectionId);
  const changed = await f.send('PUT', `/v1/collections/${pending.collectionId}/rule`, {
    revision: pending.revision,
    rule: { filter: { not: { owner: { presence: true } } }, sort: 'id' },
  });
  expect(changed.status).toBe(200);
  await expect(finalActivation().activate(pending.locator, randomUUID())).rejects.toMatchObject({
    code: 'dependency_unavailable',
  });
  const after = await outputState(pending.collectionId);
  expect(after.generations).toEqual(before.generations);
  expect(after.selected).toEqual(before.selected);
}, 120000);

test('a collected original creation receipt cannot restore final command authority or disturb selected A', async () => {
  const pending = await pendingWithSelectedA();
  const before = await outputState(pending.collectionId);
  const episode = await readCollectionPublicationEpisode(f.database.pool, pending.locator);
  if (!episode) throw new Error('The actual pending native operation is required for this receipt test');
  await f.database.admin.query(
    `DELETE FROM core.receipt WHERE partition_no=$1 AND principal_kind='account'
     AND principal_id=$2 AND command_kind=$3 AND transaction_id=$4`,
    [
      partitionOf(pending.route),
      actor.accountId,
      episode.initiator.creation.commandKind,
      episode.initiator.recordedTransactionId,
    ],
  );
  await expect(finalActivation().activate(pending.locator, randomUUID())).rejects.toMatchObject({
    code: 'dependency_unavailable',
  });
  const after = await outputState(pending.collectionId);
  expect(after.generations).toEqual(before.generations);
  expect(after.selected).toEqual(before.selected);
}, 120000);

test('a changed original authentication floor refuses final restoration before any output switch', async () => {
  const pending = await pendingWithSelectedA();
  const before = await outputState(pending.collectionId);
  await f.database.admin.query(
    `UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch+1 WHERE route=$1 AND account_id=$2`,
    [pending.route, actor.accountId],
  );
  await expect(finalActivation().activate(pending.locator, randomUUID())).rejects.toMatchObject({
    name: 'DurableInitiatorUnavailableError',
  });
  const after = await outputState(pending.collectionId);
  expect(after.generations).toEqual(before.generations);
  expect(after.selected).toEqual(before.selected);
}, 120000);
