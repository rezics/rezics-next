import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Static } from 'typebox';
import { createMainApp } from '../../../services/main/src/app.ts';
import type { followResult, followState } from '../../../services/main/src/modules/follows/contract.ts';
import { ProjectionStore } from '../../../services/main/src/modules/projection/store.ts';
import { RV } from '../../../services/main/src/modules/work/activate.ts';
import { startHomeStack } from './feed-read-support.ts';

test('read, follow, change delivery level and unfollow admitted resources and projections through the same API', async () => {
  const home = await startHomeStack('follow-any-resource');
  try {
    const { stack, json } = home;
    const app = createMainApp(stack.fuseki, { ...home.deps, mediaAccess: stack.mediaAccess,
      projections: new ProjectionStore(stack.accessPool) });
    const call = (method: string, path: string, body?: object, token = home.reader.token, key = randomUUID()) =>
      app.handle(new Request(new URL(path, 'http://main.local'), { method,
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
          ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }));
    const actor = await home.provision('Resource follower', home.reader.token);
    const editor = home.author.actor;
    const work = await stack.publicWork(editor);
    await home.author.grant(`work:read:${work.work}`, 'work.read');
    await home.author.grant('semantic:create:root', 'semantic.change');
    await home.author.grant('projection:create:root', 'projection.create');
    const revisions = new Map<string, string>();
    const semantic = async (type: string, visible = true) => {
      const saved = await json<{ component: string; revision: string }>(await call('POST',
      '/v1/semantic/changes', { profile: 'semantic-change-v1', expectedHead: null, actingSubject: editor,
        state: { component: 'resource', types: [type], properties: visible ? [{ predicate: `${RV}semanticWork`,
          value: { kind: 'resource', ref: work.work } }] : [] } }, home.author.token), 201);
      revisions.set(saved.component, saved.revision);
      return saved.component;
    };
    const character = await semantic(`${RV}Character`);
    const projection = (await json<{ projection: { id: string } }>(await call('POST', '/v1/projections', {
      subject: character, frames: [work.work], actingSubject: editor,
    }, home.author.token), 201)).projection.id;
    const hidden = await semantic(`${RV}Character`, false);
    const resources = [{ target: character, kind: `${RV}Character` }, { target: projection, kind: 'projection' },
      { target: await semantic(`${RV}GameUnit`), kind: `${RV}GameUnit` },
      { target: await semantic(`${RV}Title`), kind: `${RV}Title` }];
    const state = (target: string, kind?: string) => call('GET', `/v1/me/follow-state?${new URLSearchParams({
      target, actingSubject: actor, ...(kind ? { kind } : {}),
    })}`);
    const write = (target: string, following: boolean, expectedRevision: string | null, level?: string,
      kind?: string, key = randomUUID()) => call('POST', '/v1/follows', {
      profile: 'follow-command-v1', target, actingSubject: actor, following, expectedRevision,
      ...(level ? { level } : {}), ...(kind ? { kind } : {}),
    }, home.reader.token, key);

    // A type hint cannot admit a hidden, missing or mismatched target.
    expect((await state(character, 'work')).status).toBe(400);
    expect((await write(character, true, null, undefined, 'work')).status).toBe(404);
    for (const target of [hidden, `https://rezics.com/id/${randomUUID()}`]) {
      expect((await state(target)).status).toBe(404);
      expect((await write(target, true, null)).status).toBe(404);
    }
    const denied = await call('GET', `/v1/me/follow-state?${new URLSearchParams({
      target: character, actingSubject: actor,
    })}`, undefined, home.author.token);
    expect(denied.status).toBe(403);

    // Preflight failure is atomic even when another selected resource is public.
    expect((await call('POST', '/v1/me/follows/batch', { profile: 'follow-batch-v1', actingSubject: actor,
      targets: [character, hidden].map(target => ({ target, following: true, expectedRevision: null })),
    })).status).toBe(404);
    expect(await json(await state(character))).toMatchObject({ following: false, revision: null });

    for (const { target, kind } of resources) {
      const empty = await json<Static<typeof followState>>(await state(target));
      expect(empty).toMatchObject({ target: { id: target, kind }, following: false, revision: null,
        followers: { value: 0, kind: 'exact' } });
      expect(empty.target.href).not.toBe(target);
      expect(await json(await state(target, kind))).toEqual(empty);
      const key = randomUUID();
      let receipt = await json<Static<typeof followResult>>(await write(target, true, null, 'all', kind, key));
      expect(receipt).toMatchObject({ target, kind, following: true, level: 'all', source: 'explicit' });
      expect(await json(await write(target, true, null, 'all', kind, key))).toEqual({ ...receipt, replayed: true });
      expect((await write(target, false, null)).status).toBe(409);
      for (const level of ['highlights', 'off', 'all']) {
        receipt = (await json<{ items: Static<typeof followResult>[] }>(await call('POST', '/v1/me/follows/batch', {
          profile: 'follow-batch-v1', actingSubject: actor, targets: [{ target, level, expectedRevision: receipt.revision }],
        }))).items[0]!;
        expect(await json(await state(target))).toMatchObject({ following: true, revision: receipt.revision,
          level, source: 'explicit', followers: { value: 1, kind: 'exact' } });
      }
      const publicState = await json<Static<typeof followState>>(await app.handle(new Request(
        `http://main.local/v1/follows/${target.slice(-36)}`)));
      expect(publicState).toMatchObject({ following: null, revision: null, followers: { value: 1, kind: 'exact' } });
      const list = await json<{ items: { id: string; kind: string; href: string }[] }>(await call('GET',
        `/v1/me/follows?${new URLSearchParams({ actingSubject: actor, kind })}`));
      expect(list.items).toEqual([expect.objectContaining({ id: target, kind, href: empty.target.href })]);
      await json(await write(target, false, receipt.revision));
      expect(await json(await state(target))).toMatchObject({ following: false, followers: { value: 0, kind: 'exact' } });
    }
    // Concurrent commands still have one CAS winner on an extensible target.
    const outcomes = await Promise.all([write(character, true, null), write(character, true, null)]);
    // The tombstone keeps its revision after unfollow; both obsolete null revisions are stale.
    expect(outcomes.map(response => response.status)).toEqual([409, 409]);
    const tombstone = await json<Static<typeof followState>>(await state(character));
    const winners = await Promise.all([write(character, true, tombstone.revision), write(character, true, tombstone.revision)]);
    expect(winners.map(response => response.status).sort()).toEqual([200, 409]);
    const current = await json<Static<typeof followState>>(await state(character));
    // Losing disclosure cannot trap a reader in a follow; removal uses the owned row and CAS.
    await home.author.grant(`semantic:edit:${character}`, 'semantic.change');
    await json(await call('POST', '/v1/semantic/changes', { profile: 'semantic-change-v1', target: character,
      expectedHead: revisions.get(character), actingSubject: editor,
      state: { component: 'resource', types: [`${RV}Character`], properties: [] },
    }, home.author.token));
    expect((await state(character)).status).toBe(404);
    await json(await write(character, false, current.revision));
  } finally { await home.stop(); }
}, 240_000);
