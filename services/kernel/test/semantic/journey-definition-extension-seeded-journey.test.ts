import { expect, test } from 'bun:test';
import { bundledSources, bundledDigest } from '@rezics/definitions/bundled';
import { compileCatalogue } from '@rezics/definitions/compile';
import { releaseDigest } from '@rezics/definitions';
import {
  boardGameFixture as game,
  boardGameFixtureSources,
  boardGameLocales,
} from '../../../../packages/definitions/src/board-game-fixture.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createSemanticDriver } from './outcome-driver.ts';

test('the compiled board-game release retains launch data and publishes cited facts through native persona boundaries', async () => {
  const driver = await createSemanticDriver(
    (dependencies) =>
      createKernel({
        ...dependencies,
        access(config) {
          const access = dependencies.access!(config);
          const prepare = access.prepare!.bind(access);
          access.prepare = async (...args) => {
            try {
              return await prepare(...args);
            } catch (error) {
              console.error('Native preparation failed', args[1], error);
              throw error;
            }
          };
          const authorize = access.authorize.bind(access);
          access.authorize = async (...args) => {
            const allowed = await authorize(...args);
            if (!allowed) console.error('Native authorization denied', args[2], args[3]);
            return allowed;
          };
          return access;
        },
      }),
    { originalCapabilities: true },
  );
  const commandKey = () => ({ 'idempotency-key': JSON.stringify(crypto.randomUUID()) });
  const request = driver.request.bind(driver);
  const checked = async (answer: ReturnType<typeof request>, status: number) => {
    const value = await answer;
    expect(value.status, JSON.stringify(value.body)).toBe(status);
    return value.body as any;
  };
  try {
    const sources = boardGameFixtureSources(bundledSources());
    const release = await compileCatalogue(sources);
    const digest = releaseDigest(release);
    for (const persona of ['anonymous', 'editor', 'suspended'] as const)
      expect((await request(persona, 'POST', '/v1/definitions/releases', { release }, commandKey())).status).toBe(
        persona === 'suspended' || persona === 'anonymous' ? 401 : 403,
      );
    await checked(request('steward', 'POST', '/v1/definitions/releases', { release }, commandKey()), 201);
    const active = await checked(request('anonymous', 'GET', '/v1/definitions/active'), 200);
    expect(active.digest).toBe(bundledDigest);
    await checked(
      request(
        'steward',
        'POST',
        `/v1/definitions/releases/${digest}:activate`,
        { expected_head: active.head },
        commandKey(),
      ),
      200,
    );
    const immutable = await checked(request('anonymous', 'GET', `/v1/definitions/releases/${digest}`), 200);
    expect(immutable.release).toEqual(release);
    for (const locale of boardGameLocales) {
      const type = await checked(
        request('anonymous', 'GET', `/v1/definitionTypes/${encodeURIComponent(game.type)}?locale=${locale}`),
        200,
      );
      expect(type.label).toBe(release.types[game.type]!.labels[locale]);
      expect(type.definition.facets).toEqual([game.players, game.duration]);
    }
    for (const type of ['schema:Book', 'schema:Recipe', game.type]) {
      const created = await checked(
        request(
          'editor',
          'POST',
          '/v1/subjects',
          { type, labels: { en: type === game.type ? game.title : `Authored ${type} catalogue control` } },
          commandKey(),
        ),
        201,
      );
      const id = created.subject.id;
      expect(created.subject.release).toBe(digest);
      if (type !== game.type) continue;
      const statement = {
        property: { id: game.players },
        value: { type: 'value', content: { amount: '+4', unit: '1' } },
        references: [{ parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: game.citation } }] }],
      };
      const proposal = await checked(
        request('editor', 'POST', `/v1/subjects/${id}/candidates`, { statement }, commandKey()),
        201,
      );
      const path = `/v1/subjects/${id}/candidates/${proposal.candidate}:accept`;
      const decision = { context: driver.globalContext, expected_head: null };
      await checked(request('editor', 'POST', path, decision, commandKey()), 403);
      await checked(request('acceptor', 'POST', path, decision, commandKey()), 200);
      const adopt = {
        context: driver.globalContext,
        property: game.players,
        mode: 'replace',
        selection: [{ candidate: proposal.candidate, rank: 'preferred' }],
        expected_head: null,
      };
      await checked(request('acceptor', 'POST', `/v1/subjects/${id}:adopt`, adopt, commandKey()), 200);
      const publicRead = await checked(request('anonymous', 'GET', `/v1/subjects/${id}`), 200);
      const fact = publicRead.subject.statements[game.players][0];
      expect(fact.value).toEqual(statement.value);
      expect(fact.references).toEqual(statement.references);
      expect(fact.rezics.release).toBe(digest);
      expect(fact.rank).toBe('preferred');
      expect((await checked(request('editor', 'GET', `/v1/subjects/${id}`), 200)).subject).toEqual(publicRead.subject);
      console.log(
        JSON.stringify({
          source: game.citation,
          type,
          subject: id,
          release: digest,
          candidate: proposal.candidate,
          acceptance: 'accepted',
          adoption: 'preferred',
          publicReadback: fact.id,
        }),
      );
    }
  } finally {
    await driver.close();
  }
}, 240_000);
