import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Elysia } from 'elysia';
import { authorCreditFixture, shortId } from '../fixtures/author-credit.ts';
import {
  S3ImmutableObjects,
  type ImmutableObjects,
} from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { progressRoutes } from '../../../services/main/src/routes/progress.ts';

test('an episodic Work composes admitted Episodes and resumes episode 7 in a second session', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(
    Bun.env as Record<string, string>,
    resolve('.temp', `episodic-structure-${randomUUID()}`),
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
  const session = () =>
    new Elysia().use(
      progressRoutes(f.env.fuseki, {
        environment: f.env,
        catalogueIntake: f.catalogueIntake,
        account: f.account.verifier,
        access: f.access,
        structureObjects: objects,
        progress: new StructureProgressStore(f.pool),
      }),
    );
  const progress = (app: ReturnType<typeof session>, method: string, path: string, body?: object) =>
    app.handle(
      new Request(`http://main.local${path}`, {
        method,
        headers: {
          authorization: `Bearer ${f.account.tokenA}`,
          'idempotency-key': randomUUID(),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  try {
    const series = await f.json<{ work: string; mainVersion: string }>(
      await f.call(
        'POST',
        '/v1/works',
        await f.authoredBody({
          language: 'en',
          profile: 'metadata-only-v1',
          title: 'Anime series with specials',
          semanticTypes: ['https://schema.org/TVSeries'],
          actingSubject: f.actor,
        }),
      ),
      201,
    );
    await f.grant(`work:edit:${series.work}`, 'work.edit');
    await f.grant(`work:read:${series.work}`, 'work.read');
    await f.grant('semantic:create:root', 'semantic.change');
    const episodes: string[] = [];
    for (let number = 1; number <= 8; number++) {
      const episode = await f.json<{ component: string }>(
        await f.call('POST', '/v1/semantic/changes', {
          profile: 'semantic-change-v1',
          expectedHead: null,
          actingSubject: f.actor,
          state: {
            component: 'resource',
            types: ['https://schema.org/Episode'],
            properties: [
              {
                predicate: 'https://schema.org/name',
                value: {
                  kind: 'language-string',
                  lexical: number === 8 ? 'Special' : `Episode ${number}`,
                  language: 'en',
                },
              },
              {
                predicate: 'https://schema.org/episodeNumber',
                value: { kind: 'integer', lexical: String(number) },
              },
            ],
          },
        }),
        201,
      );
      await f.grant(`semantic:read:${episode.component}`, 'semantic.read');
      episodes.push(episode.component);
    }
    const created = await f.json<{ structure: string; revision: string }>(
      await f.call('POST', '/v1/compositions', {
        profile: 'work-composition',
        work: series.work,
        mainVersion: series.mainVersion,
        actingSubject: f.actor,
      }),
      201,
    );
    const path = `/v1/compositions/${shortId(created.structure)}`;
    const grouped = await f.json<{ revision: string; occurrences: string[] }>(
      await f.call('POST', `${path}/changes`, {
        profile: 'work-composition',
        expectedHead: created.revision,
        actingSubject: f.actor,
        operations: [
          {
            op: 'insert',
            parent: created.structure,
            position: 'last',
            role: 'group',
            label: { value: 'Specials', language: 'en' },
          },
        ],
      }),
      200,
    );
    const inserted = await f.json<{ revision: string; occurrences: string[] }>(
      await f.call('POST', `${path}/changes`, {
        profile: 'work-composition',
        expectedHead: grouped.revision,
        actingSubject: f.actor,
        operations: episodes.map((target, index) => ({
          op: 'insert',
          parent: index === 7 ? grouped.occurrences[0] : created.structure,
          position: 'last',
          role: 'part',
          target,
          displayLabel: index === 7 ? 'Special' : `Episode ${index + 1}`,
          inclusion: index === 7 ? 'extra' : 'required',
        })),
      }),
      200,
    );
    const query = `?actingSubject=${encodeURIComponent(f.actor)}`;
    const root = await f.json<{ occurrences: Array<{ role: string; target?: string }> }>(
      await f.call('GET', path + query),
      200,
    );
    expect(
      root.occurrences.filter((item) => item.role === 'part').map((item) => item.target),
    ).toEqual(episodes.slice(0, 7));
    expect(
      await f.json(
        await f.call(
          'GET',
          `${path}${query}&parent=${encodeURIComponent(grouped.occurrences[0]!)}`,
        ),
        200,
      ),
    ).toMatchObject({ occurrences: [{ target: episodes[7] }] });
    const target = await f.json<{ state: { types: string[]; properties: unknown[] } }>(
      await f.call('GET', `/v1/semantic/resources/${shortId(episodes[6]!)}${query}`),
      200,
    );
    expect(target.state.types).toContain('https://schema.org/Episode');
    expect(target.state.properties).toContainEqual(
      expect.objectContaining({
        predicate: 'https://schema.org/episodeNumber',
        value: expect.objectContaining({ lexical: '7' }),
      }),
    );
    const progressPath = `${path}/occurrences/${shortId(inserted.occurrences[6]!)}/progress`;
    expect(
      await f.json(
        await progress(session(), 'PUT', progressPath, {
          actingSubject: f.actor,
          expectedVersion: 0,
          completed: false,
          position: 'episode:7',
        }),
        200,
      ),
    ).toMatchObject({ position: 'episode:7', version: 1 });
    expect(await f.json(await progress(session(), 'GET', progressPath + query), 200)).toMatchObject(
      { occurrence: inserted.occurrences[6], position: 'episode:7', version: 1 },
    );
  } finally {
    await f.close();
  }
}, 180_000);
