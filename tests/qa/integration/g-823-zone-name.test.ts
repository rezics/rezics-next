import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import {
  S3ImmutableObjects,
  type ImmutableObjects,
} from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { assertCommandRace } from '../support/command-race.ts';

test('G823: HTTP Zone names retain writer language through rename, retry, fencing and configuration edits', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(
    Bun.env as Record<string, string>,
    resolve('.temp', `g-823-${randomUUID()}`),
    'openid space:create zone:edit semantic:read',
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
    await f.grant('space:create:root', 'space.create');
    const anonymous = createMainApp(f.env.fuseki, {
      environment: f.env,
      account: f.account.verifier,
      access: f.access,
    });
    for (const metadata of [
      { name: 'مكتبة', language: 'ar', direction: 'rtl' },
      { name: 'Writer did not choose a language', language: 'und', direction: 'ltr' },
    ]) {
      const space = await f.json<{ space: string }>(
        await f.call('POST', '/v1/spaces', {
          profile: 'space-realm-v1',
          name: 'Name test host',
          capabilities: ['realm'],
          actingSubject: f.actor,
        }),
        201,
      );
      const zone = nativeId();
      await f.grant(`zone:edit:${zone}`, 'zone.edit');
      await f.grant(`semantic:read:${zone}`, 'semantic.read');
      const body = {
        zone,
        space: space.space,
        actingSubject: f.actor,
        disclosure: 'public',
        name: metadata.name,
        ...(metadata.language === 'ar' ? { language: 'ar' } : {}),
      };
      const createKey = randomUUID();
      const created = await f.json<{ navigation: string; revision: string }>(
        await f.call('POST', '/v1/zones', body, createKey),
        201,
      );
      expect(await f.json(await f.call('POST', '/v1/zones', body, createKey), 200)).toMatchObject({
        ...created,
        replayed: true,
      });
      expect(
        (await f.call('POST', '/v1/zones', { ...body, language: 'he' }, createKey)).status,
      ).toBe(409);
      const root = `/v1/zones/${shortId(zone)}`;
      const config = `${root}/configuration`;
      const actorQuery = `actingSubject=${encodeURIComponent(f.actor)}`;
      const current = await f.json<{ revision: string }>(
        await f.call('GET', `${config}?${actorQuery}`),
        200,
      );
      expect(current).toMatchObject(metadata);
      const detail = await f.json<{ ownerRevision: string }>(
        await f.call('GET', `${root}?${actorQuery}`),
        200,
      );
      expect(detail).toMatchObject({ ...metadata, ownerRevision: current.revision });
      const presentation = await anonymous.handle(
        new Request(`http://main.local${root}/presentation`, {
          headers: { 'accept-language': 'ja', 'x-rezics-display-languages': 'en' },
        }),
      );
      expect(presentation.status).toBe(200);
      expect(await presentation.json()).toMatchObject(metadata);
      const oldEtag = presentation.headers.get('etag')!;
      const home = await anonymous.handle(new Request(`http://main.local${root}/routes?path=/`));
      expect(home.status).toBe(200);
      expect(await home.json()).toMatchObject(metadata);
      const historical = await f.json(
        await f.call('GET', `${root}/revisions/${shortId(created.revision)}?${actorQuery}`),
        200,
      );
      expect(historical).toMatchObject(metadata);

      const updated = await f.json<{ revision: string }>(
        await f.call('PUT', config, {
          expectedHead: current.revision,
          actingSubject: f.actor,
          budget: { timeMs: 500, rows: 20 },
          advancedBase64: Buffer.from('{"retained":true}').toString('base64'),
        }),
        200,
      );
      expect(await f.json(await f.call('GET', `${config}?${actorQuery}`), 200)).toMatchObject(
        metadata,
      );
      const renameKey = randomUUID();
      const rename = {
        expectedHead: updated.revision,
        actingSubject: f.actor,
        name: 'ספרייה',
        language: 'he',
      };
      const originalFuseki = f.env.fuseki;
      let lostRename = false;
      f.env.fuseki = new Proxy(originalFuseki, {
        get(target, property) {
          if (property === 'commandWithReceipt')
            return async (...args: Parameters<typeof target.commandWithReceipt>) => {
              const result = await target.commandWithReceipt(...args);
              if (!lostRename && args[0].update.includes('ZoneConfigureEvent')) {
                lostRename = true;
                throw new Error('Lost Zone rename acknowledgement');
              }
              return result;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as typeof originalFuseki;
      const renamed = await f.json<{ revision: string }>(
        await f.call('PUT', config, rename, renameKey),
        200,
      );
      f.env.fuseki = originalFuseki;
      expect(lostRename).toBe(true);
      expect(await f.json(await f.call('PUT', config, rename, renameKey), 200)).toMatchObject({
        revision: renamed.revision,
        replayed: true,
      });
      expect((await f.call('PUT', config, { ...rename, name: 'Stale' })).status).toBe(409);
      expect(
        (
          await f.call('PUT', config, {
            ...rename,
            expectedHead: renamed.revision,
            name: undefined,
            language: 'ar',
          })
        ).status,
      ).toBe(400);
      expect(
        (await f.call('PUT', config, { ...rename, expectedHead: renamed.revision, name: '   ' }))
          .status,
      ).toBe(400);
      const state = await readZoneConfiguration(f.env, zone);
      expect(state).toMatchObject({
        name: 'ספרייה',
        language: 'he',
        direction: 'rtl',
        configuration: { budget: { timeMs: 500, rows: 20 }, advanced: expect.any(String) },
        advancedBase64: Buffer.from('{"retained":true}').toString('base64'),
      });
      for (const endpoint of ['configuration', 'showcase-editor']) {
        const hidden = await f.json(
          await f.call('GET', `${root}/${endpoint}?${actorQuery}`, undefined, randomUUID(), f.account.tokenB),
          404,
        );
        const missingRoot = `/v1/zones/${shortId(nativeId())}`;
        expect(await f.json(await f.call('GET', `${missingRoot}/${endpoint}?${actorQuery}`), 404))
          .toEqual(hidden);
        expect(await f.json(await f.call('GET', `${missingRoot}/${endpoint}?${actorQuery}`,
          undefined, randomUUID(), f.account.tokenB), 404)).toEqual(hidden);
      }
      expect(
        (
          await f.call(
            'PUT',
            config,
            { ...rename, expectedHead: renamed.revision },
            randomUUID(),
            f.account.tokenB,
          )
        ).status,
      ).toBe(403);
      const refreshed = await anonymous.handle(
        new Request(`http://main.local${root}/presentation`, {
          headers: { 'if-none-match': oldEtag },
        }),
      );
      expect(refreshed.status).toBe(200);
      expect(await refreshed.json()).toMatchObject({
        name: 'ספרייה',
        language: 'he',
        direction: 'rtl',
      });
      const unchosen = await f.json<{ revision: string }>(
        await f.call('PUT', config, {
          expectedHead: renamed.revision,
          actingSubject: f.actor,
          name: 'New language unchosen',
        }),
        200,
      );
      expect(await f.json(await f.call('GET', `${root}?${actorQuery}`), 200)).toMatchObject({
        name: 'New language unchosen',
        language: 'und',
        direction: 'ltr',
        ownerRevision: unchosen.revision,
      });
      expect(
        (
          await f.env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
        ${iri(zone)} <https://schema.org/name> ?name } }`)
        ).boolean,
      ).toBe(false);
      const retired = await f.json<{ revision: string }>(
        await f.call('POST', `${root}/retirements`, {
          expectedHead: unchosen.revision,
          actingSubject: f.actor,
        }),
        200,
      );
      const recovered = await f.json<{ revision: string }>(
        await f.call('POST', `${root}/recoveries`, {
          expectedHead: retired.revision,
          actingSubject: f.actor,
        }),
        200,
      );
      expect(await f.json(await f.call('GET', `${config}?${actorQuery}`), 200)).toMatchObject({
        name: 'New language unchosen',
        language: 'und',
        direction: 'ltr',
      });
      const concurrentCommands = ['Winner A', 'Winner B'].map((name) =>
        f.call.bind(
          f,
          'PUT',
          config,
          {
            expectedHead: recovered.revision,
            actingSubject: f.actor,
            name,
            language: 'en',
          },
          randomUUID(),
        ),
      );
      const concurrent = await assertCommandRace(
        await Promise.all(concurrentCommands.map((send) => send())),
        200,
        (index) => concurrentCommands[index]!(),
      );
      const winner = (await concurrent.find((response) => response.status === 200)!.json()) as {
        revision: string;
      };
      expect(await f.json(await f.call('GET', `${config}?${actorQuery}`), 200)).toMatchObject({
        revision: winner.revision,
        language: 'en',
        direction: 'ltr',
      });
    }
  } finally {
    await f.close();
  }
}, 180_000);
