import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import {
  beginCollectionSourceOutput,
  completeCollectionSourceOutput,
} from '../../src/library/collection-source-output.ts';
import { createInitiatorRestorer } from '../../src/access/durable-initiator.ts';
import { createCurrentConsentReader } from '../../../auth/src/current-consent.ts';
import {
  mintReadTime,
  releaseOperationalTime,
  runCommand,
  noEffect,
  principalCommandIdentity,
} from '../../src/command/command.ts';
import {
  createCollectionPublicationEpisodes,
  readCollectionPublicationEpisode,
  readCollectionPublicationInitiator,
  readCollectionPublicationRule,
} from '../../src/library/collection-publication-episodes.ts';
import { builtinCollectionId } from '../../src/library/builtin-identity.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { identitySupport } from '../imports/identity-fixture.ts';
import { createCollectionRulesFixture, type CollectionRulesFixture } from './support/collection-rules-fixture.ts';

let f: CollectionRulesFixture;
let actor: AccountActor;
let bearer: string;
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
  const support = identitySupport(f.runtime.identity),
    clientId = `publication-episode-${randomUUID()}`;
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
  bearer = ((await issued.json()) as { access_token: string }).access_token;
  actor = await f.runtime.identity.access.authenticate(bearer, { pool: f.database.pool, deadline: Date.now() + 30000 });
}, 120000);
afterAll(async () => {
  await f?.close();
});
const episodes = () =>
  createCollectionPublicationEpisodes({ pool: f.database.pool, access: f.runtime.identity.access });
async function prepared() {
  const subject = await f.subject('Native episode original');
  await f.entry(subject);
  const response = await f.send('POST', '/v1/collections', {
    title: 'Whole private query',
    visibility: 'private',
    membershipKind: 'dynamic',
    rule: { filter: { owner: { presence: true } }, sort: 'id' },
  });
  expect(response.status).toBe(201);
  const { collection } = await response.json();
  // Begin allocates the native Source identity itself; it does not require/pretend full-query completion.
  return {
    collectionId: collection.id as string,
    revision: collection.revision as number,
    visibility: 'public' as const,
  };
}

test('Whole-query publication begins with a real authorized immutable operation source and independently verified native creation receipt instead of a fabricated durable actor', async () => {
  const input = await prepared(),
    key = randomUUID();
  const command = await episodes().begin(actor, input, key);
  const episode = await readCollectionPublicationEpisode(f.database.pool, command.value.locator);
  expect(episode).not.toBeNull();
  if (!episode) throw new Error('Original episode evidence required');
  expect(episode.phase).toBe('staging');
  expect(episode.output.state).toBe('building');
  expect(episode.output).not.toHaveProperty('publication');
  expect(episode.selected).toBeNull();
  expect(episode.initiator.actor).toEqual(actor);
  expect(episode.initiator.recordedTransactionId).toBe(command.transactionId);
  expect(episode.initiator.originalAccount.minimumAuthnEpoch).toMatch(/^[1-9][0-9]*$/);
  expect(episode.durableInitiator).toBe(command.value.durableInitiator);
  expect(episode.source.input.identity).toMatchObject({
    scope: 'private_builtin',
    collectionId: input.collectionId,
    accountId: actor.accountId,
  });
  expect(episode.source.target).toMatchObject({ collectionId: input.collectionId, visibility: 'public' });
  expect(await readCollectionPublicationRule(f.database.pool, command.value.locator)).not.toBeNull();
  const rows = (
    await f.database.pool.query(
      `SELECT o.xmin=b.xmin AND o.xmin=s.xmin AND o.xmin=r.xmin AS original,
    g.expected_members,c.visibility,c.revision,s.bytes
    FROM library.collection_publication_operation o JOIN library.collection_publication_source s USING(route,source_id)
    JOIN editorial.write_basis b ON b.partition_no=(o.route >> 4) AND b.transaction_id=o.transaction_id
    JOIN core.receipt r ON r.partition_no=b.partition_no AND r.principal_kind='account' AND r.principal_id=o.owner_account_id
      AND r.command_kind=o.record->'creation'->>'commandKind' AND r.idempotency_key=o.creation_storage_key
    JOIN library.collection c ON (c.route,c.collection_id)=(o.route,o.collection_id)
    JOIN library.collection_source_output g ON g.route=o.route AND g.collection_id=o.collection_id
      AND g.generation=(s.bytes::jsonb->'output'->>'generation')::uuid
    WHERE o.route=$1 AND o.publication_id=$2`,
      [command.value.locator.route, command.value.locator.publicationId],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    original: true,
    expected_members: null,
    visibility: 'private',
    revision: input.revision,
  });
  for (const privateField of ['filter', 'scopes', 'bearer', 'authnEpoch', 'originalAccount'])
    expect(JSON.parse(rows[0].bytes)).not.toHaveProperty(privateField);
  expect((await episodes().begin(actor, input, key)).value).toEqual(command.value);
  await expect(episodes().begin(actor, { ...input, visibility: 'unlisted' }, key)).rejects.toMatchObject({
    name: 'IdempotencyConflictError',
  });
  expect(
    (
      await f.database.pool.query(
        'SELECT 1 FROM library.collection_publication_operation WHERE route=$1 AND publication_id=$2',
        [command.value.locator.route, command.value.locator.publicationId],
      )
    ).rowCount,
  ).toBe(1);
  await expect(
    f.database.admin.query(
      'UPDATE library.collection_publication_source SET bytes=$3 WHERE route=$1 AND source_id=$2',
      [command.value.locator.route, episode.initiator.operation.sourceId, '{}'],
    ),
  ).rejects.toThrow('collection_publication_immutable');
}, 120000);

test('replay rejects current revoked native family scope and changed accepted Collection source', async () => {
  const input = await prepared(),
    key = randomUUID();
  const created = await episodes().begin(actor, input, key);
  // A different real Auth credential, rather than a copied/reconstructed actor, loses a required scope.
  const reduced = await f.runtime.identity.access.authenticate(f.reduced, {
    pool: f.database.pool,
    deadline: Date.now() + 30000,
  });
  await expect(episodes().begin(reduced, input, key)).rejects.toThrow();
  const updated = await f.send('PUT', `/v1/collections/${input.collectionId}/rule`, {
    revision: input.revision,
    rule: { filter: { not: { owner: { presence: true } } }, sort: 'id' },
  });
  expect(updated.status).toBe(200);
  expect(await readCollectionPublicationRule(f.database.pool, created.value.locator)).toBeNull();
  await expect(episodes().begin(actor, input, key)).rejects.toThrow();
}, 120000);

test('collected exact creation receipt makes the native reader and common helper unavailable without reconstruction', async () => {
  const input = await prepared(),
    created = await episodes().begin(actor, input, randomUUID());
  const episode = await readCollectionPublicationEpisode(f.database.pool, created.value.locator);
  if (!episode) throw new Error('Real original episode required before retention fault');
  const keys = [
    partitionOf(routeOf(actor.accountId)!),
    actor.accountId,
    episode.initiator.creation.commandKind,
    episode.initiator.recordedTransactionId,
  ];
  // Simulated collection of that exact receipt; no replacement evidence or positive rows are inserted.
  await f.database.admin.query(
    `DELETE FROM core.receipt WHERE partition_no=$1 AND principal_kind='account'
    AND principal_id=$2 AND command_kind=$3 AND transaction_id=$4`,
    keys,
  );
  expect(await readCollectionPublicationEpisode(f.database.pool, created.value.locator)).toBeNull();
  const tx = await f.database.pool.connect();
  const time = await mintReadTime(tx, () => new Date());
  try {
    expect(await readCollectionPublicationInitiator(tx, episode.initiator.operation, time)).toBeNull();
  } finally {
    releaseOperationalTime(time);
    tx.release();
  }
  const support = identitySupport(f.runtime.identity);
  const consent = createCurrentConsentReader({ database: support.authDatabase.pool });
  let reads = 0;
  const restorer = createInitiatorRestorer({
    pool: f.database.pool,
    access: f.runtime.identity.access,
    readConsent: (input) => consent.readCurrentConsent(input),
    readOperation: async (...args) => {
      reads++;
      return readCollectionPublicationInitiator(...args);
    },
  });
  await expect(
    runCommand(
      f.database.pool,
      {
        partition: partitionOf(created.value.locator.route),
        deadline: Date.now() + 30000,
        authorization: {
          action: 'collection:update',
          resource: { route: created.value.locator.route, id: input.collectionId },
          denied: () => new Error('Native restoration required'),
          async prepare(attempt) {
            return restorer.restoreInitiator(
              {
                operation: episode.initiator.operation,
                action: 'collection:update',
                anchor: {
                  resource: { route: created.value.locator.route, id: input.collectionId },
                  async validate(client) {
                    return (
                      (
                        await client.query(
                          'SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2 AND state=$3',
                          [created.value.locator.route, input.collectionId, 'active'],
                        )
                      ).rows.length === 1
                    );
                  },
                },
                context: { pool: f.database.pool, deadline: Date.now() + 30000 },
              },
              attempt.time,
            );
          },
          async authorize() {
            throw new Error('Missing original receipt must refuse before command authorization');
          },
        },
      },
      async () => noEffect(null),
    ),
  ).rejects.toMatchObject({ name: 'DurableInitiatorUnavailableError' });
  expect(reads).toBe(1);
}, 120000);

test('first native Everything publication materializes the stable logical ID with native grants and keeps Liked private', async () => {
  const collectionId = builtinCollectionId(actor.accountId, { kind: 'everything' });
  const result = await episodes().begin(actor, { collectionId, revision: 0, visibility: 'unlisted' }, randomUUID());
  const episode = await readCollectionPublicationEpisode(f.database.pool, result.value.locator);
  expect(episode?.source.rule).toMatchObject({
    kind: 'builtin',
    key: { kind: 'everything' },
    collectionRevision: 1,
    sourceGeneration: '0',
  });
  expect(episode?.source.output.collectionId).toBe(collectionId);
  expect(episode?.output.state).toBe('building');
  expect(episode?.output).not.toHaveProperty('publication');
  expect(await readCollectionPublicationRule(f.database.pool, result.value.locator)).not.toBeNull();
  const header = (
    await f.database.pool.query(
      `SELECT c.visibility,c.revision,c.builtin_release_digest,i.creator_id::text AS creator
    FROM library.collection c JOIN access.resource_initialization i ON (i.route,i.resource_id)=(c.route,c.collection_id)
    WHERE c.route=$1 AND c.collection_id=$2`,
      [routeOf(collectionId), collectionId],
    )
  ).rows[0];
  expect(header).toMatchObject({ visibility: 'private', revision: 1, creator: actor.accountId });
  expect(header.builtin_release_digest).toBe(episode?.source.rule.releaseDigest);
  const liked = builtinCollectionId(actor.accountId, { kind: 'liked' });
  await expect(
    episodes().begin(actor, { collectionId: liked, revision: 0, visibility: 'public' }, randomUUID()),
  ).rejects.toThrow();
  expect(
    (
      await f.database.pool.query('SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2', [
        routeOf(liked),
        liked,
      ])
    ).rows,
  ).toHaveLength(0);
}, 120000);

test('whole-query B preserves the original selected A receipt and public membership fence', async () => {
  const input = await prepared();
  const changed = await f.send('PATCH', `/v1/collections/${input.collectionId}`, {
    revision: input.revision,
    visibility: 'public',
  });
  expect(changed.status).toBe(200);
  const revision = (await changed.json()).collection.revision as number;
  const route = routeOf(input.collectionId)!,
    deadline = Date.now() + 30000;
  // An explicit empty prior selection is real A; it makes no claim to exhaust the private query.
  const output = { route, collectionId: input.collectionId, generation: randomUUID() };
  const a = await runCommand(
    f.database.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline,
      receipt: {
        kind: 'library.collection.explicit-output',
        key: randomUUID(),
        digest: createHash('sha256').update(JSON.stringify(output)).digest(),
      },
      authorization: resourceAuthorization({
        access: f.runtime.identity.access,
        actor,
        action: 'collection:update',
        anchor: {
          resource: { route, id: input.collectionId },
          async validate(client) {
            return (
              (
                await client.query(
                  `SELECT 1 FROM library.collection WHERE route=$1 AND collection_id=$2
          AND curator_account_id=$3 AND state='active' AND revision=$4`,
                  [route, input.collectionId, actor.accountId, revision],
                )
              ).rows.length === 1
            );
          },
        },
        context: { pool: f.database.pool, partition: partitionOf(route), deadline },
      }),
    },
    async (tx) => {
      await beginCollectionSourceOutput(tx, { ...output, expectedMembers: 0 });
      await completeCollectionSourceOutput(tx, output);
      return {
        value: output,
        events: [
          {
            type: 'com.rezics.library.collection.updated.v1',
            subject: input.collectionId,
            data: { collectionId: input.collectionId },
          },
        ],
      };
    },
  );
  const b = await episodes().begin(
    actor,
    { collectionId: input.collectionId, revision, visibility: 'unlisted' },
    randomUUID(),
  );
  const episode = await readCollectionPublicationEpisode(f.database.pool, b.value.locator);
  expect(episode?.phase).toBe('staging');
  expect(episode?.selected?.ref).toEqual(output);
  expect(episode?.selected?.publication.transactionId).toBe(a.transactionId);
  expect(episode?.selected?.publication.members).toBe('0');
  expect(episode?.output.state).toBe('building');
  expect(episode?.output).not.toHaveProperty('publication');
  expect(episode?.source.output.generation).not.toBe(output.generation);
  expect(
    (
      await f.database.pool.query(
        'SELECT visibility,revision FROM library.collection WHERE route=$1 AND collection_id=$2',
        [route, input.collectionId],
      )
    ).rows[0],
  ).toEqual({ visibility: 'public', revision });
}, 120000);
