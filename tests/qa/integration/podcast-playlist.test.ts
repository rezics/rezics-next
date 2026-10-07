import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import {
  S3ImmutableObjects,
  type ImmutableObjects,
} from '../../../services/main/src/infrastructure/immutable-objects.ts';
import {
  CommandRejected,
  FusekiClient,
  type MembershipPreparationInput,
} from '../../../services/main/src/infrastructure/fuseki.ts';
import { GRAPHS, RV, hash, iri } from '../../../services/main/src/modules/work/activate.ts';
import { hasUnnormalizedMembership, normalizeStoredMembership } from '../../../services/main/src/modules/structure/membership-normalize.ts';
import { assertOwnerMigrationsComplete, migrateOwnerData } from '../../../scripts/fixture/migrate.ts';
import { readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';

test('a podcast playlist survives automatic owner upgrade, interruption, reads and new writes', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(
    Bun.env as Record<string, string>,
    resolve('.temp', `podcast-playlist-${randomUUID()}`),
    'openid work:create work:edit work:read collection:edit semantic:read',
  );
  const objects = new S3ImmutableObjects({
    endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/',
  });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    await f.grant('semantic:create:root', 'semantic.change');
    const episodes: string[] = [];
    for (let number = 1; number <= 2; number++) {
      const episode = await f.json<{ component: string }>(
        await f.call('POST', '/v1/semantic/changes', {
          profile: 'semantic-change-v1',
          expectedHead: null,
          actingSubject: f.actor,
          state: {
            component: 'resource',
            types: ['https://schema.org/PodcastEpisode'],
            properties: [
              {
                predicate: 'https://schema.org/name',
                value: {
                  kind: 'language-string',
                  lexical: `Podcast episode ${number}`,
                  language: 'en',
                },
              },
            ],
          },
        }),
        201,
      );
      await f.grant(`semantic:read:${episode.component}`, 'semantic.read');
      episodes.push(episode.component);
    }
    const collection = nativeId();
    await f.grant(`collection:edit:${collection}`, 'collection.edit');
    await f.grant(`semantic:read:${collection}`, 'semantic.read');
    const created = await f.json<{ structure: string; revision: string }>(
      await f.call('POST', '/v1/collections', {
        collection,
        name: 'Podcast playlist',
        disclosure: 'public',
        actingSubject: f.actor,
      }),
      201,
    );
    const path = `/v1/collections/${shortId(collection)}`;
    const inserted = await f.json<{ revision: string; occurrences: string[] }>(
      await f.call('POST', `${path}/changes`, {
        expectedHead: created.revision,
        actingSubject: f.actor,
        operations: [...episodes, episodes[0]].map((target) => ({
          op: 'insert',
          role: 'member',
          parent: created.structure,
          position: 'last',
          target,
        })),
      }),
      200,
    );
    expect(new Set(inserted.occurrences).size).toBe(3);
    const positions = async () =>
      (
        await f.env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/> SELECT ?occurrence ?position WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(created.structure)} rv:selectedGeneration ?generation .
          ?placement rv:generation ?generation ; rv:occurrence ?occurrence ; schema:position ?position .
        } } ORDER BY ?occurrence`)
      ).results?.bindings ?? [];
    const beforeMove = await positions();
    const moved = await f.json<{ revision: string; cost: { placementsWritten: number } }>(
      await f.call('POST', `${path}/changes`, {
        expectedHead: inserted.revision,
        actingSubject: f.actor,
        operations: [
          {
            op: 'move',
            occurrence: inserted.occurrences[2],
            parent: created.structure,
            position: 'first',
          },
        ],
      }),
      200,
    );
    expect(moved.cost.placementsWritten).toBe(1);
    expect(
      (await positions()).filter((row) => row.occurrence!.value !== inserted.occurrences[2]),
    ).toEqual(beforeMove.filter((row) => row.occurrence!.value !== inserted.occurrences[2]));
    const query = `?actingSubject=${encodeURIComponent(f.actor)}`;
    const page = await f.json<{ occurrences: Array<{ occurrence: string; target: string }> }>(
      await f.call('GET', path + query),
      200,
    );
    expect(page.occurrences.map((item) => item.occurrence)).toEqual([
      inserted.occurrences[2]!,
      inserted.occurrences[0]!,
      inserted.occurrences[1]!,
    ]);
    expect(page.occurrences.map((item) => item.target)).toEqual([episodes[0]!, ...episodes]);
    const earlier = await f.json<{ occurrences: Array<{ occurrence: string }> }>(
      await f.call('GET', `${path}/revisions/${shortId(inserted.revision)}${query}`),
      200,
    );
    expect(earlier.occurrences.map((item) => item.occurrence)).toEqual(inserted.occurrences);
    const membership = async () =>
      (
        await f.env.fuseki.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/> SELECT ?occurrence ?item ?position WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(created.structure)} rv:selectedGeneration ?generation .
          ?list a schema:ItemList ; rv:generation ?generation ; rv:parent ${iri(created.structure)} ;
            schema:itemListElement ?placement .
          ?placement a schema:ListItem ; rv:occurrence ?occurrence ; schema:item ?item ; schema:position ?position .
        } } ORDER BY ?position`)
      ).results?.bindings ?? [];
    const projected = await membership();
    expect(projected.map((row) => row.occurrence!.value)).toEqual(
      page.occurrences.map((item) => item.occurrence),
    );
    expect(projected.every((row) => row.position!.type === 'literal')).toBe(true);
    // More than one transaction is required so interrupted preparation must resume.
    const extraCollection = nativeId();
    await f.grant(`collection:edit:${extraCollection}`, 'collection.edit');
    await f.grant(`semantic:read:${extraCollection}`, 'semantic.read');
    const extra = await f.json<{ structure: string; revision: string }>(
      await f.call('POST', '/v1/collections', { collection: extraCollection,
        name: 'Populated upgrade copy', disclosure: 'public', actingSubject: f.actor }), 201);
    const extraPath = `/v1/collections/${shortId(extraCollection)}`;
    let extraHead = extra.revision;
    const extraOccurrences: string[] = [];
    for (const size of [16, 9]) {
      const change = await f.json<{ revision: string; occurrences: string[] }>(
        await f.call('POST', `${extraPath}/changes`, { expectedHead: extraHead,
          actingSubject: f.actor, operations: Array.from({ length: size }, (_, index) => ({
            op: 'insert', role: 'member', parent: extra.structure, position: 'last',
            target: episodes[index % 2],
          })) }), 200);
      extraHead = change.revision;
      extraOccurrences.push(...change.occurrences);
    }
    // The disposable populated dataset models a pre-normalization stored copy.
    await f.nativeFuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      DELETE { GRAPH ${iri(GRAPHS.current)} { ?placement a schema:ListItem ;
        schema:item ?item ; schema:position ?position . ?list ?p ?o . } }
      INSERT { GRAPH ${iri(GRAPHS.current)} { ?placement rv:target ?item . } }
      WHERE { GRAPH ${iri(GRAPHS.current)} { VALUES ?structure { ${iri(created.structure)} ${iri(extra.structure)} }
        ?structure rv:selectedGeneration ?generation .
        ?placement rv:generation ?generation ; schema:item ?item ; schema:position ?position .
        ?list rv:generation ?generation ; a schema:ItemList ; ?p ?o . } }`);
    expect(await membership()).toHaveLength(0);
    // A malformed stored role must reject the whole native conversion turn,
    // including its receipt. PartRole is not admitted by CollectionMembership.
    const replaceRoles = async (from: string, to: string) => f.nativeFuseki.update(`PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.current)} { ?placement rv:occurrenceRole rv:${from} } }
      INSERT { GRAPH ${iri(GRAPHS.current)} { ?placement rv:occurrenceRole rv:${to} } }
      WHERE { GRAPH ${iri(GRAPHS.current)} { VALUES ?structure { ${iri(created.structure)} ${iri(extra.structure)} }
        ?structure rv:selectedGeneration ?generation .
        ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrenceRole rv:${from} . } }`);
    await replaceRoles('MemberRole', 'PartRole');
    await expect(normalizeStoredMembership(f.env)).rejects.toBeInstanceOf(
      CommandRejected,
    );
    expect(await membership()).toHaveLength(0);
    expect(await hasUnnormalizedMembership(f.env.fuseki)).toBe(true);
    await replaceRoles('PartRole', 'MemberRole');
    const apps = Bun.env as Record<string, string>;
    // Run the real preparation hook used by dev:refresh and installRelease.
    // Lose preparation after a committed 24-placement batch, before batch two.
    const prepare = FusekiClient.prototype.membershipPrepare;
    let batches = 0;
    let receipt = '';
    const interrupted = spyOn(FusekiClient.prototype, 'membershipPrepare').mockImplementation(
      async function(this: FusekiClient, input: MembershipPreparationInput, signal?: AbortSignal) {
        if (batches === 1) {
          batches = 2;
          throw new Error('interrupted owner preparation');
        }
        const result = await prepare.call(this, input, signal);
        // A populated store can need dry seek turns before these legacy rows.
        if (result.status === 'committed' && result.placements > 0) {
          batches = 1;
          receipt = result.receipts[0]!;
        }
        return result;
      });
    try {
      await expect(migrateOwnerData(apps)).rejects.toThrow('interrupted owner preparation');
    } finally { interrupted.mockRestore(); }
    expect(batches).toBe(2);
    expect(await hasUnnormalizedMembership(f.env.fuseki)).toBe(true);
    const upgraded = await migrateOwnerData(apps);
    assertOwnerMigrationsComplete(upgraded);
    expect(upgraded.find(row => row.owner === 'catalogue-statements')?.status).toBe('complete');
    expect(upgraded.find(row => row.owner === 'ordered-membership')).toMatchObject({
      status: 'complete', placements: 4, receipts: [expect.any(String)],
    });
    expect(await hasUnnormalizedMembership(f.env.fuseki)).toBe(false);
    expect(await membership()).toEqual(projected);
    const extraPage = await f.json<{ occurrences: Array<{ occurrence: string }> }>(
      await f.call('GET', extraPath + query), 200);
    expect(extraPage.occurrences.map(row => row.occurrence)).toEqual(extraOccurrences);
    expect(new Set(extraOccurrences).size).toBe(25);
    const position = (
      await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?count WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:dataEpoch ?epoch ; rv:sequence ?sequence ; rv:placementCount ?count } }`)
    ).results!.bindings[0]!;
    expect(
      await readMainOutboxEnvelope(
        f.env.fuseki,
        {
          batchId: `urn:rezics:outbox:${hash(receipt)}`,
          eventIds: [`urn:rezics:event:${hash(receipt)}`],
          dataEpoch: position.epoch!.value,
          sequence: position.sequence!.value,
          routingEpoch: f.env.lineage.routingEpoch,
        },
        `urn:rezics:event:${hash(receipt)}`,
      ),
    ).toMatchObject({
      data: {
        receipt: { systemProof: { kind: 'ordered-membership-normalization', placements: 24 } },
      },
    });
    expect(await f.json(await f.call('GET', path + query), 200)).toMatchObject({
      revision: moved.revision,
      occurrences: page.occurrences,
    });
    expect(Number(position.count?.value)).toBe(24);
    const written = await f.json<{ revision: string; occurrences: string[] }>(
      await f.call('POST', `${path}/changes`, { expectedHead: moved.revision,
        actingSubject: f.actor, operations: [{ op: 'insert', role: 'member',
          parent: created.structure, position: 'last', target: episodes[0] }] }), 200);
    const after = await f.json<{ occurrences: Array<{ occurrence: string; target: string }> }>(
      await f.call('GET', path + query), 200);
    expect(after.occurrences.map(row => row.occurrence)).toEqual([
      ...page.occurrences.map(row => row.occurrence), ...written.occurrences,
    ]);
    expect(new Set(after.occurrences.map(row => row.occurrence)).size).toBe(4);
    expect(after.occurrences.at(-1)?.target).toBe(episodes[0]);
    const datasetPosition = async () => (await f.env.fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?sequence WHERE { GRAPH ${iri(GRAPHS.control)} { ?dataset rv:sequence ?sequence } }`))
      .results?.bindings;
    const beforeRepeat = await datasetPosition();
    const repeated = await migrateOwnerData(apps);
    assertOwnerMigrationsComplete(repeated);
    expect(repeated.find(row => row.owner === 'catalogue-statements')?.status).toBe('complete');
    expect(repeated.find(row => row.owner === 'ordered-membership')).toMatchObject({
      status: 'complete', placements: 0, receipts: [],
    });
    expect(await datasetPosition()).toEqual(beforeRepeat);
    expect(await f.json(await f.call('GET', path + query), 200)).toMatchObject(after);
    expect(await hasUnnormalizedMembership(f.env.fuseki)).toBe(false);

  } finally {
    await f.close();
  }
}, 180_000);
