import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { WikiQuotationStore } from '../../../services/main/src/modules/wiki/quotation.ts';
import { CatalogueIntakeStore } from '../../../services/main/src/modules/catalogue-intake/store.ts';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { prideExample } from '../../../packages/wiki-toolkit/skill/examples/pride.ts';

test('G-848: model-free skill units, alignment, candidates and validation produce an acceptable bundle on the local QA stack', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration QA tier');
  const directory = resolve('.temp', `g-848-${randomUUID()}`);
  const f = await authorCreditFixture(
    Bun.env as Record<string, string>,
    directory,
    'openid work:create work:edit work:read space:create zone:edit collection:edit semantic:read wiki:propose',
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
  const app = createMainApp(f.env.fuseki, {
    environment: f.env,
    account: f.account.verifier,
    access: f.access,
    structureObjects: objects,
    wikiQuotations: new WikiQuotationStore(f.pool),
    catalogueIntake: new CatalogueIntakeStore(f.accessPool, f.env),
  });
  const call = (path: string, body: object) =>
    app.handle(
      new Request(`http://main.local${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${f.account.tokenA}`,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify(body),
      }),
    );
  async function json<T>(response: Response, status = 200): Promise<T> {
    const text = await response.text();
    if (response.status !== status)
      throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
    return JSON.parse(text) as T;
  }
  try {
    const { candidateReceipt } = await json<{ candidateReceipt: string }>(
      await call('/v1/catalogue/candidates', {
        profile: 'catalogue-candidates-v1',
        originalTitle: { value: 'Pride and Prejudice', language: 'en' },
        aliases: [],
        romanizations: [],
        creators: [],
        dates: [],
        identifiers: [],
      }),
    );
    const work = await json<{ work: string; mainVersion: string }>(
      await call('/v1/works', {
        profile: 'metadata-only-v1',
        grain: 'new-creative-scope',
        candidateReceipt,
        title: 'Pride and Prejudice',
        language: 'en',
        semanticTypes: ['https://schema.org/Book'],
        actingSubject: f.actor,
      }),
      201,
    );
    await f.grant(`work:read:${work.work}`, 'work.read');
    await f.grant(`work:edit:${work.work}`, 'work.edit');
    const structure = await json<{ structure: string; revision: string }>(
      await call('/v1/compositions', {
        profile: 'book-composition',
        work: work.work,
        mainVersion: work.mainVersion,
        actingSubject: f.actor,
      }),
      201,
    );
    const chapter = await json<{ occurrences: string[] }>(
      await call(`/v1/compositions/${shortId(structure.structure)}/changes`, {
        profile: 'book-composition',
        expectedHead: structure.revision,
        actingSubject: f.actor,
        operations: [
          {
            op: 'insert',
            parent: structure.structure,
            position: 'last',
            role: 'chapter',
            target: 'https://schema.org/DigitalDocument',
            label: { value: 'Chapter one', language: 'en' },
          },
        ],
      }),
    );
    await f.grant('semantic:create:root', 'semantic.change');
    const predicate = await json<{ component: string }>(
      await call('/v1/semantic/changes', {
        profile: 'semantic-change-v1',
        expectedHead: null,
        actingSubject: f.actor,
        state: { component: 'definition', kind: 'property' },
      }),
      201,
    );
    await f.grant(`semantic:read:${predicate.component}`, 'semantic.read');
    const franchise = nativeId();
    await f.grant(`collection:edit:${franchise}`, 'collection.edit');
    await f.grant(`semantic:read:${franchise}`, 'semantic.read');
    const collection = await json<{ structure: string; revision: string }>(
      await call('/v1/collections', {
        collection: franchise,
        name: 'Pride and Prejudice franchise',
        language: 'en',
        disclosure: 'public',
        actingSubject: f.actor,
      }),
      201,
    );
    await json(
      await call(`/v1/collections/${shortId(franchise)}/changes`, {
        expectedHead: collection.revision,
        actingSubject: f.actor,
        operations: [
          {
            op: 'insert',
            role: 'member',
            parent: collection.structure,
            position: 'last',
            target: work.work,
          },
        ],
      }),
    );
    await f.grant('space:create:root', 'space.create');
    const space = await json<{ space: string }>(
      await call('/v1/spaces', {
        profile: 'space-realm-v1',
        name: 'Pride wiki',
        capabilities: ['realm'],
        actingSubject: f.actor,
      }),
      201,
    );
    const zone = nativeId();
    await f.grant(`zone:edit:${zone}`, 'zone.edit');
    await f.grant(`semantic:read:${zone}`, 'semantic.read');
    const navigation = await json<{ revision: string }>(
      await call('/v1/zones', {
        zone,
        space: space.space,
        disclosure: 'public',
        actingSubject: f.actor,
      }),
      201,
    );
    await json(
      await call(`/v1/zones/${shortId(zone)}/mounts`, {
        expectedHead: navigation.revision,
        target: franchise,
        routeSegment: 'franchise',
        position: 'last',
        disclosure: 'public',
        actingSubject: f.actor,
      }),
    );
    const file = 'tests/fixtures/wiki-toolkit/pride.txt';
    const lines = execFileSync('bun', ['packages/wiki-toolkit/src/cli.ts', 'units', file], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
      .trim()
      .split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(61);
    const bundle = prideExample(readFileSync(file), {
      target: work.work,
      zone,
      continuity: work.work,
      occurrence: chapter.occurrences[0]!,
      predicate: predicate.component,
    });
    const candidates = await json<{ items: { status: string }[] }>(
      await call('/v1/wiki/candidates', {
        target: work.work,
        zone,
        actingSubject: f.actor,
        names: [
          { value: 'Mr. Bennet', language: 'en', type: 'https://rezics.com/vocab/Character' },
        ],
      }),
    );
    expect(candidates.items[0]!.status).toBe('new');
    const evidence = bundle.claims[0]!.evidence[0]!;
    const verified = JSON.parse(
      execFileSync(
        'bun',
        ['packages/wiki-toolkit/src/cli.ts', 'verify', file, JSON.stringify(evidence.locator)],
        { encoding: 'utf8' },
      ),
    );
    expect(verified.quote).toBe(evidence.quote);
    expect(
      await json(await call('/v1/wiki/validations', { actingSubject: f.actor, bundle })),
    ).toMatchObject({
      status: 'acceptable',
      entities: [{ id: 'mr-bennet', action: 'create' }],
      alignment: [{ status: 'aligned' }],
    });
  } finally {
    await f.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);

test.skip('G-848: submit wiki-bundle and later-chapter deltas — pending G-865 proposal contract', () => {});
