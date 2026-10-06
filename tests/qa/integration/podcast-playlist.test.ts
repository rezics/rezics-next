import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import {
  S3ImmutableObjects,
  type ImmutableObjects,
} from '../../../services/main/src/infrastructure/immutable-objects.ts';
import {
  CommandRejected,
  type CommandEnvelope,
} from '../../../services/main/src/infrastructure/fuseki.ts';
import { GRAPHS, RV, hash, iri } from '../../../services/main/src/modules/work/activate.ts';
import { normalizeStoredMembership } from '../../../services/main/src/modules/structure/membership-normalize.ts';
import { readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';

test('a podcast playlist creates, reorders and reads episode membership through Collection', async () => {
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
    // The disposable populated dataset models a pre-normalization stored copy.
    await f.nativeFuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      DELETE { GRAPH ${iri(GRAPHS.current)} { ?placement a schema:ListItem ;
        schema:item ?item ; schema:position ?position . ?list ?p ?o . } }
      INSERT { GRAPH ${iri(GRAPHS.current)} { ?placement rv:target ?item . } }
      WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(created.structure)} rv:selectedGeneration ?generation .
        ?placement rv:generation ?generation ; schema:item ?item ; schema:position ?position .
        ?list rv:generation ?generation ; a schema:ItemList ; ?p ?o . } }`);
    expect(await membership()).toHaveLength(0);
    // Removing position produces malformed ListItems; SHACL rejects the complete
    // transaction, including its receipt and all membership conversions.
    const malformed = new Proxy(f.env.fuseki, {
      get(target, property) {
        if (property === 'commandWithReceipt')
          return (envelope: CommandEnvelope) =>
            target.commandWithReceipt({
              ...envelope,
              update: envelope.update.replace(/ ; schema:position "[^"]+"/g, ''),
            });
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(normalizeStoredMembership({ ...f.env, fuseki: malformed })).rejects.toBeInstanceOf(
      CommandRejected,
    );
    expect(await membership()).toHaveLength(0);
    const normalized = await normalizeStoredMembership(f.env);
    expect(normalized).toMatchObject({ complete: true, placements: 3 });
    expect(normalized.receipts).toHaveLength(1);
    expect(await membership()).toEqual(projected);
    expect(await normalizeStoredMembership(f.env)).toEqual({
      complete: true,
      placements: 0,
      receipts: [],
    });
    const receipt = normalized.receipts[0]!;
    const position = (
      await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:dataEpoch ?epoch ; rv:sequence ?sequence } }`)
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
        receipt: { systemProof: { kind: 'ordered-membership-normalization', placements: 3 } },
      },
    });
    expect(await f.json(await f.call('GET', path + query), 200)).toMatchObject({
      revision: moved.revision,
      occurrences: page.occurrences,
    });
  } finally {
    await f.close();
  }
}, 120_000);
