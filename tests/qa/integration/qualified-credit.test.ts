import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import { primaryDiscoveryCreditBatch } from '../../../services/main/src/modules/discovery/credits.ts';
import { searchPageCredits } from '../../../services/main/src/modules/search/result-cards.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;

test('catalogue editors credit provider-qualified staff and translators without inventing an Agent', async () => {
  const stack = await startMediaStack('qualified-credit', { profileCredits: true });
  try {
    const member = await stack.member('qualified-credit');
    const created = await stack.publicWork(member.actor, ['en'], 'A staff-credited work');
    await member.grant(`work:edit:${created.work}`, 'work.edit');
    const head = (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(created.work)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
    const credit = native();
    const key = randomUUID();
    const body = { profile: 'native-agent-credit-v1', credit,
      participant: { kind: 'external-reference', provider: 'vndb', namespace: 'staff', key: 's42' },
      role: 'director', ordinal: 2, expectedWorkHead: head, actingSubject: member.actor };
    const path = `/v1/works/${created.work.slice(-36)}/agent-credits`;
    const write = await member.send('POST', path, body, key);
    const text = await write.text();
    expect(write.status, text).toBe(201);
    const committed = JSON.parse(text) as { credit: string; revision: string };
    const retry = await member.send('POST', path, body, key);
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect(await retry.json()).toMatchObject({ credit, revision: committed.revision, replayed: true });
    const translator = native();
    const translated = await member.send('POST', path, { profile: 'native-agent-credit-v1', credit: translator,
      agent: member.actor, role: 'translator', expectedWorkHead: head, actingSubject: member.actor });
    expect(translated.status, await translated.clone().text()).toBe(201);
    await stack.templateSeek.backfill(stack.env.lineage.dataEpoch, true);
    const page = await stack.call('GET', `/v1/works/${created.work.slice(-36)}/credits`);
    expect(page.status, await page.clone().text()).toBe(200);
    const listed = await page.json() as { items: Array<Record<string, unknown>> };
    expect(listed.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: credit, role: 'director', participantKind: 'external-reference',
        provider: 'vndb', namespace: 'staff', key: 's42', ordinal: 2, agent: null }),
      expect.objectContaining({ id: translator, role: 'translator', participantKind: 'agent', agent: member.actor }),
    ]));
    const session = new WorkReadSession(stack.composition.dependencies, new Request('http://main.local/v1/works'), {},
      { dataEpoch: stack.env.lineage.dataEpoch, sequence: '0' });
    const discovery = await primaryDiscoveryCreditBatch(session, [created.work]);
    expect(discovery.get(created.work)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: credit, role: 'director', provider: 'vndb', namespace: 'staff', agent: null }),
      expect.objectContaining({ id: translator, role: 'translator', agent: member.actor }),
    ]));
    const search = await searchPageCredits(session, [created.work]);
    expect(search.get(created.work)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: credit, role: 'director', provider: 'vndb', namespace: 'staff' }),
    ]));
    const invented = await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(credit)} rv:agent ?agent } }`);
    expect(invented.boolean).toBe(false);
  } finally { await stack.stop(); }
}, 180_000);
