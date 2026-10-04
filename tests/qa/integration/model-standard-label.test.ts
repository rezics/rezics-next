import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { CONTEXT_COST } from '../../../services/main/src/modules/context/schema.ts';
import { contextFixture, nativeId, RV } from './context-fixture.ts';
import { assertCommandRace } from '../support/command-race.ts';

const short = (id: string) => id.split('/').at(-1)!;

test('MODEL13: Label as scoped SKOS labels retain lexical value, language and exact Context qualifiers', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const target = nativeId();
    const definition = nativeId();
    await f.grant('context:create:root', 'context.create');
    const create = () => f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
      entries: [{ target, relation: `${RV}classifiedAs`, state: 'defined', definition,
        applicability: [] }], actingSubject: f.actorA });
    const first = await f.json<{ context: string; semanticRevision: string }>(await create(), 201);
    const second = await f.json<{ context: string; semanticRevision: string }>(await create(), 201);
    const path = (context: string) => `/v1/contexts/${short(context)}/preferences`;
    const body = (label: string, head: string | null) => ({
      profile: 'context-preference-v1', expectedPreferenceHead: head,
      labels: [{ target, language: 'en', label }], actingSubject: f.actorA });
    await f.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)',
      [`context:change:${first.context}`]);
    expect((await f.call('POST', path(first.context), body('Scarlet', null))).status).toBe(403);
    await f.grant(`context:change:${first.context}`, 'context.preference');
    await f.grant(`context:change:${second.context}`, 'context.preference');
    f.resetQueries();
    const key = randomUUID();
    const chosen = await f.json<{ preferenceRevision: string; replayed: boolean }>(
      await f.call('POST', path(first.context), body('Scarlet', null), key), 201);
    expect(f.queries()).toBeLessThanOrEqual(CONTEXT_COST.preferenceWrite.graphQueries + 6);
    expect(await f.json<{ preferenceRevision: string; replayed: boolean }>(
      await f.call('POST', path(first.context), body('Scarlet', null), key), 200))
      .toMatchObject({ preferenceRevision: chosen.preferenceRevision, replayed: true });
    const other = await f.json<{ preferenceRevision: string }>(
      await f.call('POST', path(second.context), body('Red', null)), 201);
    const contendersCommands = ['Crimson', 'Ruby'].map((label) =>
      f.call.bind(
        f,
        'POST',
        path(first.context),
        body(label, chosen.preferenceRevision),
        randomUUID(),
      ),
    );
    const contenders = await assertCommandRace(
      await Promise.all(contendersCommands.map((send) => send())),
      201,
      (index) => contendersCommands[index]!(),
    );
    const winner = contenders.find(response => response.status === 201)!;
    const winnerLabel = contenders.indexOf(winner) === 0 ? 'Crimson' : 'Ruby';
    const revised = await f.json<{ preferenceRevision: string }>(winner, 201);
    const historical = await f.json<{ labels: { target: string; language: string; label: string }[] }>(
      await f.call('GET', `${path(first.context)}?revision=${encodeURIComponent(chosen.preferenceRevision)}`), 200);
    expect(historical.labels).toEqual([{ target, language: 'en', label: 'Scarlet' }]);
    const read = (context: string, revision: string) => f.call('GET',
      `/v1/contexts/${short(context)}/skos?preferenceRevision=${encodeURIComponent(revision)}`);
    f.resetQueries();
    const scoped = await f.json<{ '@graph': Array<Record<string, any>>;
      semanticRevision: string; preferenceRevision: string }>(
      await read(first.context, revised.preferenceRevision), 200);
    expect(f.queries()).toBeLessThanOrEqual(CONTEXT_COST.skosRead.graphQueries + 6);
    const separate = await f.json<typeof scoped>(await read(second.context, other.preferenceRevision), 200);
    expect(scoped.semanticRevision).toBe(first.semanticRevision);
    expect(scoped.preferenceRevision).toBe(revised.preferenceRevision);
    expect(scoped['@graph']).toHaveLength(1);
    expect(scoped['@graph'][0]).toMatchObject({ '@type': 'skos:Concept',
      'rv:interprets': { '@id': target },
      'rv:semanticRevision': { '@id': first.semanticRevision },
      'rv:preferenceRevision': { '@id': revised.preferenceRevision },
      'skos:prefLabel': { '@value': winnerLabel, '@language': 'en' } });
    expect(separate['@graph'][0]).toMatchObject({ 'skos:prefLabel': {
      '@value': 'Red', '@language': 'en' } });
    expect(scoped['@graph'][0]?.['@id']).not.toBe(separate['@graph'][0]?.['@id']);
    expect((await f.call('POST', path(first.context), { ...body('Duplicate', revised.preferenceRevision),
      labels: [{ target, language: 'en', label: 'A' },
        { target, language: 'en', label: 'B' }] })).status).toBe(400);
  } finally { await f.close(); }
}, 120_000);
