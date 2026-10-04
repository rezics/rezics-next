import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { CONTEXT_COST } from '../../../services/main/src/modules/context/schema.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { RV, contextFixture, nativeId, shortId } from './context-fixture.ts';
import { assertCommandRace } from '../support/command-race.ts';

type Written = { context: string; semanticRevision: string; revision: string; replayed: boolean;
  expectedHead: string | null; sourcePosition: { sequence: string } };
type Read = { revision: string; semanticHead: string; entries: unknown[]; predecessor: string | null };

test('Context template: real Account/Access/Main/Jena write, exact read, denial, stale, race and lost response', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const health = await f.env.fuseki.commandHealth();
    expect(health.profiles['context-v1']).toBe(profileRegistry['context-v1'].sha256);
    const concept = nativeId();
    const definition = nativeId();
    const body = { profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
      entries: [{ target: concept, relation: null, state: 'defined', definition, applicability: [] }],
      actingSubject: f.actorA };
    const key = `context-${randomUUID()}`;
    expect((await f.call('POST', '/v1/contexts', body, key, null)).status).toBe(401);
    const deniedGrant = await f.grant('context:create:root', 'context.create');
    await f.revoke(deniedGrant);
    expect((await f.call('POST', '/v1/contexts', body, key)).status).toBe(403);
    await f.grant('context:create:root', 'context.create');
    const created = await f.json<Written>(await f.call('POST', '/v1/contexts', body, key), 201);
    expect(created).toMatchObject({ replayed: false, expectedHead: null });
    const createdBatch = await readNextMainOutboxBatch(f.env.fuseki, created.sourcePosition.dataEpoch,
      (BigInt(created.sourcePosition.sequence) - 1n).toString());
    expect(createdBatch?.sequence).toBe(created.sourcePosition.sequence);
    const createdEvent = await readMainOutboxEnvelope(f.env.fuseki, createdBatch!, createdBatch!.eventIds[0]!);
    expect(createdEvent).toMatchObject({ type: 'com.rezics.context.created.v1',
      data: { receipt: { action: 'context.create', outcome: 'succeeded', component: created.context,
        revision: created.semanticRevision } } });
    // Replays return the committed receipt; the same key with another body conflicts.
    expect(await f.json<Written>(await f.call('POST', '/v1/contexts', body, key), 200))
      .toMatchObject({ context: created.context, semanticRevision: created.semanticRevision, replayed: true });
    expect((await f.call('POST', '/v1/contexts', { ...body, disclosure: 'private' }, key)).status).toBe(409);

    const path = `/v1/contexts/${shortId(created.context)}`;
    const first = await f.json<Read>(await f.call('GET', path, undefined, randomUUID(), null), 200);
    expect(first).toMatchObject({ revision: created.semanticRevision, semanticHead: created.semanticRevision,
      entries: body.entries, predecessor: null });

    // A Context editor needs its own change grant; creating one grants nothing else.
    const revise = (expectedSemanticHead: string, target = nativeId()) => ({ profile: 'context-v1',
      expectedSemanticHead, base: null, actingSubject: f.actorA,
      entries: [{ target, relation: null, state: 'defined', definition: nativeId(), applicability: [] }] });
    const deniedChangeGrant = await f.grant(`context:change:${created.context}`, 'context.change');
    await f.revoke(deniedChangeGrant);
    expect((await f.call('POST', `${path}/semantic-revisions`, revise(created.semanticRevision))).status).toBe(403);
    const changeGrant = await f.grant(`context:change:${created.context}`, 'context.change');
    const second = await f.json<Written>(await f.call('POST', `${path}/semantic-revisions`,
      revise(created.semanticRevision)), 201);
    expect(second.expectedHead).toBe(created.semanticRevision);
    const stale = await f.call('POST', `${path}/semantic-revisions`, revise(created.semanticRevision));
    expect(stale.status).toBe(409);
    expect((await stale.json() as { code: string }).code).toBe('stale_head');

    // Two successors prepared from one head: exactly one commits, the other seals stale.
    const raceCommands = [
      f.call.bind(
        f,
        'POST',
        `${path}/semantic-revisions`,
        revise(second.semanticRevision),
        randomUUID(),
      ),
      f.call.bind(
        f,
        'POST',
        `${path}/semantic-revisions`,
        revise(second.semanticRevision),
        randomUUID(),
      ),
    ];
    const race = await assertCommandRace(
      await Promise.all(raceCommands.map((send) => send())),
      201,
      (index) => raceCommands[index]!(),
    );
    const winner = await (race.find(response => response.status === 201)!).json() as Written;

    // Exact old revisions stay readable after successors; missing or corrupt bytes are unavailable.
    const old = await f.json<Read>(await f.call('GET', `${path}?revision=${encodeURIComponent(created.semanticRevision)}`,
      undefined, randomUUID(), null), 200);
    expect(old).toMatchObject({ revision: created.semanticRevision, semanticHead: winner.semanticRevision,
      entries: body.entries });
    const manifest = (await f.env.fuseki.query(`SELECT ?m WHERE { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(created.semanticRevision)} <${RV}manifest> ?m } }`)).results?.bindings[0]?.m?.value!;
    const bytes = join(f.env.objectDirectory, manifest.slice(-64));
    const saved = readFileSync(bytes);
    renameSync(bytes, `${bytes}.held`);
    try {
      expect((await f.call('GET', `${path}?revision=${encodeURIComponent(created.semanticRevision)}`)).status).toBe(503);
    } finally { renameSync(`${bytes}.held`, bytes); }
    writeFileSync(bytes, 'corrupt');
    try {
      expect((await f.call('GET', `${path}?revision=${encodeURIComponent(created.semanticRevision)}`)).status).toBe(503);
    } finally { writeFileSync(bytes, saved); }

    // Lost graph acknowledgement: the command resolves its own receipt, and a retry replays it.
    const lostKey = `lost-${randomUUID()}`;
    const lostBody = revise(winner.semanticRevision);
    f.loseNextResponse('context-revise-v1');
    const lost = await f.json<Written>(await f.call('POST', `${path}/semantic-revisions`, lostBody, lostKey), 201);
    expect(await f.json<Written>(await f.call('POST', `${path}/semantic-revisions`, lostBody, lostKey), 200))
      .toMatchObject({ semanticRevision: lost.semanticRevision, replayed: true });

    // Revocation fences later changes.
    await f.revoke(changeGrant);
    expect((await f.call('POST', `${path}/semantic-revisions`, revise(lost.semanticRevision))).status).toBe(403);

    // Cost contract: one fenced read regardless of revision count.
    f.resetQueries();
    await f.json<Read>(await f.call('GET', path, undefined, randomUUID(), null), 200);
    expect(f.queries()).toBeLessThanOrEqual(CONTEXT_COST.contextRead.graphQueries);
  } finally { await f.close(); }
}, 120_000);
