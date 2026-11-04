import { expect, test } from 'bun:test';
import { AuthenticationError, type Actor } from '../../src/request/access.ts';
import type { FeedItem } from '../../src/content/feed-contract.ts';
import { prepareFeedSubjectReactions } from '../../src/content/feed-subject-reactions.ts';
import { readSubjectSummaries } from '../../src/semantic/summaries.ts';
import counts from '../../src/content/reaction-count-page.sql';
import { routeOf } from '../../src/route/route.ts';
import { observeSql } from './support/sql-observer.ts';
import { createReactionRelayBase } from './reaction-relay-convergence-fixture.ts';
import { suspendAccount } from '../support/native-suspension-driver.ts';

test('selected native Subject projections distinguish coverage, five kinds, clear and private viewer slots', async () => {
  const world = await createReactionRelayBase();
  let effects: Awaited<ReturnType<typeof world.startEffects>> | undefined;
  try {
    const dependencies = { pool: world.system.database.pool, access: world.system.access, tokens: world.system.tokenKeys };
    const actor = world.system.actors.other.actor;
    const created = await world.command<{ subject: { id: string } }>('POST', '/v1/subjects', {
      type: 'schema:Book', labels: { en: 'Home reaction discovery' },
    });
    const id = created.subject.id;
    const summaries = await readSubjectSummaries({ ...dependencies, routeKey: world.system.routeKey,
      actor, deadline: Date.now() + 30_000 }, [id], { languages: ['en'] });
    const summary = summaries.get(id)!;
    const row: FeedItem = { id: `following:${id}`, source: 'following', occurredAt: null,
      key: { owner: 'semantic', kind: summary.type, route: routeOf(id)!, id }, summary,
      destination: { kind: 'subject', id, title: summary.label?.value ?? null } };
    const prepare = (reader: Actor = actor, items: readonly FeedItem[] = [row]) =>
      prepareFeedSubjectReactions(dependencies, reader, items, Date.now() + 30_000);
    const read = async (reader: Actor = actor) => (await (await prepare(reader)).finish())[0]!.summary;
    expect(await read()).toMatchObject({ subjectReactions: {
      target: { targetKind: 'subject', targetId: id }, counts: { state: 'unavailable' },
      viewer: { state: 'available', kind: null }, action: 'unavailable',
    } });
    effects = await world.startEffects();
    const write = async (kind: string | null) => {
      const capture = await effects!.captureBeforeWrite(world.other.accountId);
      await world.command(kind === null ? 'DELETE' : 'PUT', `/v1/subjects/${id}/reaction`,
        kind === null ? undefined : { kind }, { bearer: world.other.bearer });
      const delivery = await capture.read();
      await effects!.waitForEffect(delivery.envelope, delivery.eventSeq);
    };
    for (const kind of ['like', 'love', 'laugh', 'insightful', 'sad']) {
      await write(kind);
      expect(await read()).toMatchObject({ subjectReactions: {
        counts: { state: 'available', values: { [kind]: 1 } }, viewer: { state: 'available', kind }, action: 'allowed',
      } });
    }
    expect(await read(world.system.actors.author.actor)).toMatchObject({ subjectReactions: {
      viewer: { state: 'available', kind: null }, counts: { values: { sad: 1 } },
    } });
    await write(null);
    expect(await read()).toMatchObject({ subjectReactions: {
      counts: { state: 'available', values: {}, asOf: { epoch: expect.any(Number), position: expect.any(String) } },
      viewer: { state: 'available', kind: null }, action: 'allowed',
    } });

    const trace = observeSql(dependencies.pool);
    try {
      const duplicate: FeedItem = { ...row, id: `discovery:${id}`, source: 'discovery' };
      const projected = await (await prepare({ kind: 'anonymous' }, [row, duplicate])).finish();
      expect(projected).toHaveLength(2);
      for (const item of projected) {
        const projection = 'subjectReactions' in item.summary ? item.summary.subjectReactions : undefined;
        expect(projection?.action).toBe('sign_in');
        expect(projection).not.toHaveProperty('viewer');
        expect(projection?.counts).toEqual({ state: 'available', values: {}, asOf: expect.any(Object) });
      }
      expect(trace.records.filter(({ statement }) => statement.includes('content.reaction_total'))).toHaveLength(1);
      expect(trace.records.filter(({ statement }) => statement.includes('content.reaction AS'))).toHaveLength(0);
      trace.armFault({ match: { statement: counts.sql }, boundary: 'before', error: new Error('Count home unavailable') });
      await expect(prepare()).rejects.toThrow('Count home unavailable');
      expect(await read()).toMatchObject({ subjectReactions: { viewer: { kind: null }, counts: { values: {} } } });
    } finally { await trace.close(); }

    // The seam retains identities, not the caller's mutable card object.
    const original = structuredClone(row);
    const pending = await prepare(actor, [original]);
    original.destination.id = world.conceptId;
    expect((await pending.finish())[0]?.destination.id).toBe(id);
    await expect(prepare(actor, Array.from({ length: 21 }, () => row))).rejects.toThrow('At most 20');
    await expect(prepare(actor, [{ ...row, destination: { kind: 'subject', id: world.conceptId, title: null } }]))
      .rejects.toThrow('Ambiguous feed Subject reaction target');

    const hidden = await prepare();
    await world.command('POST', `/v1/subjects/${id}:hide`, { reason: 'Current Home disclosure' },
      { bearer: world.governance.bearer, expectedStatus: 200 });
    expect(await hidden.finish()).toEqual([]);
    expect(row.summary).not.toHaveProperty('subjectReactions');
  } finally { await effects?.stop(); await world.system.close(); }
}, 120_000);

test('final native identity and account checks retire merged cards and suspended callers', async () => {
  const world = await createReactionRelayBase();
  try {
    const dependencies = { pool: world.system.database.pool, access: world.system.access, tokens: world.system.tokenKeys };
    const actor = world.system.actors.other.actor;
    const ids: string[] = [];
    for (const label of ['Original Home subject', 'Surviving Home subject']) {
      const created = await world.command<{ subject: { id: string } }>('POST', '/v1/subjects', {
        type: 'schema:Book', labels: { en: label },
      });
      ids.push(created.subject.id);
    }
    const summaries = await readSubjectSummaries({ ...dependencies, routeKey: world.system.routeKey,
      actor, deadline: Date.now() + 30_000 }, ids, { languages: ['en'] });
    const rows: FeedItem[] = ids.map((id) => {
      const summary = summaries.get(id)!;
      return { id: `following:${id}`, source: 'following', occurredAt: null,
        key: { owner: 'semantic', kind: summary.type, route: routeOf(id)!, id }, summary,
        destination: { kind: 'subject', id, title: summary.label?.value ?? null } };
    });
    const pending = await prepareFeedSubjectReactions(dependencies, actor, rows, Date.now() + 30_000);
    const merged = await world.command<{ redirected: string; survivor: string }>('POST', '/v1/subjects:merge',
      { subjects: ids }, { bearer: world.governance.bearer, expectedStatus: 200 });
    const current = await pending.finish();
    expect(current.some((item) => item.key.id === merged.redirected)).toBe(false);
    for (const item of current) expect(item.key.id).toBe(item.destination.id);
    const survivor = rows.find((item) => item.key.id === merged.survivor)!;
    const suspended = await prepareFeedSubjectReactions(dependencies, actor, [survivor], Date.now() + 30_000);
    await suspendAccount(dependencies.pool, world.other.accountId);
    // Authentication failure is propagated to the page owner, never converted to
    // an authenticated null slot. Some native adapters withhold the whole row.
    try { expect(await suspended.finish()).toEqual([]); }
    catch (error) { expect(error).toBeInstanceOf(AuthenticationError); }
  } finally { await world.system.close(); }
}, 120_000);
