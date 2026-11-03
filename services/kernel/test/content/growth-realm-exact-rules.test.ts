import { expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { capture, checkGrowth, costOf, seed, assertGrowthAccessPaths } from '../support/growth.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  betweenRulesRounds, bounds, createRulesFixture, emptyPresentation, pressure, rulesKey, scales,
  unavailableRules, type Pin,
} from './support/growth-realm-exact-rules-fixture.ts';

test.serial('native settings admit an immutable exact pin and enforce current disclosure and Text limits', async () => {
  const f = await createRulesFixture();
  try {
    const target = await f.target('Exact rules');
    const other = await f.target('Other Realm');
    expect((await f.presentations([target.realmId])).get(target.realmId)?.rules)
      .toEqual({ state: 'none', value: null });

    // The maximum selected chain is authored through native command admission.
    let pin: Pin = target;
    for (let depth = 1; depth < 33; depth++) pin = await f.reply(target, pin.postId, depth === 32 ? 65536 : 512);
    const adopted = await f.adopt(pin);
    const key = rulesKey(pin, pin.realmId);
    const original = (await f.exact([pin])).get(key)!;
    expect(original).toBeDefined();
    expect(Buffer.byteLength(serializeDocument(original.body))).toBe(65536);
    const head = adopted.value.realm.headRevisionId as string;

    const edited = await f.call('POST', `/v1/posts/${pin.postId}/revisions`, {
      body: fromPlainText('Later edits must not replace the adopted rules'),
    }, { head: pin.revisionId, status: 200 });
    expect(edited.value.post.revisionId).not.toBe(pin.revisionId);
    const available = (await f.presentations([pin.realmId, pin.realmId])).get(pin.realmId)!;
    expect(available.rules).toEqual({ state: 'available', value: original });
    const board = await f.call('GET', `/v1/boards/${target.boardId}`);
    expect(board.value.board.community.rules).toEqual(available.rules);

    // Native settings replay returns the original pin; a stale fresh command still refuses.
    const replayKey = crypto.randomUUID();
    const settings = { summary: 'Pinned rules replay',
      presentation: { ...emptyPresentation, rules: { postId: pin.postId, revisionId: pin.revisionId } } };
    const updated = await f.patchRealm(pin.realmId, settings, { key: replayKey, head });
    const replay = await f.patchRealm(pin.realmId, settings, { key: replayKey, head });
    expect(replay.value.realm.headRevisionId).toBe(updated.value.realm.headRevisionId);
    await f.patchRealm(pin.realmId, settings, { head, status: 412 });

    const oversized = await f.reply(target, target.rootId, 65537);
    expect((await f.exact([oversized])).size).toBe(0);
    await f.adopt(oversized).then(() => { throw new Error('Oversized rules were admitted'); }, error => {
      expect(String(error)).toContain('400');
    });
    const missing = { ...pin, revisionId: newId(routeOf(pin.postId)!) };
    const wrongPost = { ...pin, postId: target.rootId };
    const wrongRealm = { ...pin, realmId: other.realmId };
    for (const refused of [missing, wrongPost, wrongRealm]) {
      expect([...(await f.exact([refused])).values()]).toEqual([]);
    }
    await f.patchRealm(other.realmId, settings, { status: 400 });
    expect((await f.presentations([other.realmId], unavailableRules(f.system.access))).get(other.realmId)?.rules)
      .toEqual({ state: 'none', value: null });
    const unavailable = (await f.presentations([pin.realmId], unavailableRules(f.system.access))).get(pin.realmId)!;
    expect(unavailable.rules).toEqual({ state: 'unavailable', value: null });
    expect(JSON.stringify(unavailable.rules)).not.toContain(pin.revisionId);

    // Real native transitions between released snapshots exercise signature matching.
    const changing = async (transition: () => Promise<void>) => {
      const pool = betweenRulesRounds(f.db.pool, transition);
      expect((await f.exact([pin], f.system.access, pool)).size).toBe(0);
      expect((await f.exact([pin])).has(key)).toBe(true);
    };
    await changing(async () => {
      await f.patchRealm(pin.realmId, { summary: 'Changed Realm source signature' });
    });
    await changing(async () => {
      const space = (await f.call('GET', `/v1/spaces/${target.spaceId}`, undefined, {
        bearer: f.system.actors.author.bearer,
      })).value.space;
      await f.call('PATCH', `/v1/spaces/${target.spaceId}`, { summary: 'Changed Space source signature' }, {
        head: space.headRevisionId,
      });
    });
    await changing(async () => {
      await f.call('POST', `/v1/posts/${pin.postId}/revisions`, { body: fromPlainText('Second current head') }, {
        head: edited.value.post.revisionId, status: 200,
      });
    });
    const lost = await f.exact([pin], f.system.access, betweenRulesRounds(f.db.pool, async () => {
      await f.patchRealm(pin.realmId, { visibility: 'protected' });
    }));
    expect(lost.size).toBe(0);
    expect((await f.presentations([pin.realmId])).size).toBe(0);
    const hidden = await f.call('GET', `/v1/boards/${target.boardId}`, undefined, { status: 404 });
    expect(hidden.text).not.toContain(pin.revisionId);
    expect(hidden.text).not.toContain(serializeDocument(original.body));
    await f.patchRealm(pin.realmId, { visibility: 'public' });
    const concealed = await f.exact([pin], f.system.access, betweenRulesRounds(f.db.pool, () => f.conceal(target.rootId)));
    expect(concealed.size).toBe(0);
    const after = (await f.presentations([pin.realmId])).get(pin.realmId)!;
    expect(after.rules).toEqual({ state: 'none', value: null });
    expect(JSON.stringify(after)).not.toContain(pin.revisionId);

    // Exact boundary admission is independent of whether any selected keys exist.
    const ids = Array.from({ length: 100 }, () => newId(routeOf(target.realmId)!));
    expect((await f.presentations(ids)).size).toBe(0);
    await expect(f.presentations([...ids, target.realmId])).rejects.toThrow('At most 100 routed Realms');
    expect((await f.exact(Array.from({ length: 100 }, () => missing))).size).toBe(0);
    await expect(f.exact(Array.from({ length: 101 }, () => missing))).rejects.toThrow('At most 100 rules references');
  } finally { await f.close(); }
}, 240_000);

for (const axis of ['population', 'history'] as const) {
  test.serial(`exact prepared rules disclosure has fixed work under independent ${axis} growth`, async () => {
    const f = await createRulesFixture();
    try {
      const target = await f.target('Selected rules');
      const unselected = await f.target('Unselected pressure');
      const parent = await f.reply(target, target.rootId);
      const pin = await f.reply(target, parent.postId, 4096);
      await f.adopt(pin);
      await f.call('POST', `/v1/posts/${pin.postId}/revisions`, { body: fromPlainText('Unadopted later head') }, {
        head: pin.revisionId, status: 200,
      });
      const expected = (await f.exact([pin])).get(rulesKey(pin, pin.realmId))!;
      expect(expected).toBeDefined();
      const population = await pressure(f, unselected, axis, target);
      const missing = { ...pin, revisionId: newId(routeOf(pin.postId)!) };
      const mismatches = [{ ...pin, realmId: unselected.realmId }, { ...pin, postId: target.rootId }, missing];
      const page = [target.realmId, target.realmId, unselected.realmId] as const;
      // Register the production module on the observed pool. Reads terminate synchronously;
      // no projection, membership producer or writer job supplies successful rules facts.
      await f.registerEffects();
      const report = await checkGrowth(f.db, {
        name: `Content exact pinned Realm rules: independent ${axis}`,
        scales, bounds, rule: 'series',
        grow: (database, scale, previous) => seed(database, population, { from: previous, to: scale }),
        async operation() {
          const exact = await f.exact([pin, pin]);
          expect(exact.size).toBe(1);
          expect(exact.get(rulesKey(pin, pin.realmId))).toEqual(expected);
          const composed = await f.presentations(page);
          expect(composed.size).toBe(2);
          expect(composed.get(pin.realmId)?.rules).toEqual({ state: 'available', value: expected });
          expect(composed.get(unselected.realmId)?.rules).toEqual({ state: 'none', value: null });
          // Refused requests remain inside observation, including admission with no SQL.
          expect((await f.exact(mismatches)).size).toBe(0);
          await expect(f.exact(Array.from({ length: 101 }, () => pin))).rejects.toThrow('At most 100 rules references');
          const unavailable = await f.presentations(page, unavailableRules(f.system.access));
          expect(unavailable.get(pin.realmId)?.rules).toEqual({ state: 'unavailable', value: null });
        },
      });
      expect(report.samples.map(sample => sample.scale)).toEqual([...scales]);
      assertGrowthAccessPaths(report.name, report.samples, [
        'content.post', 'content.revision', 'content.thread', 'content.board',
        'community.realm', 'community.realm_revision', 'community.space', 'community.space_revision',
      ]);
      for (const sample of report.samples) {
        expect(sample.cost.statements).toBe(report.samples[0]!.cost.statements);
        expect(sample.cost.rows).toBe(report.samples[0]!.cost.rows);
        expect(sample.cost.backgroundStatements ?? 0).toBe(0);
        expect(sample.statementRepetitions.every(statements => statements.length > 0)).toBe(true);
      }
      // Bind deduplication to native physical work, rather than just a Map's size.
      const single = await capture(f.db, () => f.presentations([pin.realmId, unselected.realmId]));
      const duplicate = await capture(f.db, () => f.presentations(page));
      expect(costOf(duplicate.capture).statements).toBe(costOf(single.capture).statements);
      expect(costOf(duplicate.capture).rows).toBe(costOf(single.capture).rows);
      expect(duplicate.capture.statements.filter(sql => sql.includes('octet_length(r.body)')).length).toBe(2);
    } finally { await f.close(); }
  }, 240_000);
}
