import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { startMediaStack } from './media-support.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';

async function json<T>(response: Response, status: number): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('Community creation reserves one handle and filters the directory by global Concept', async () => {
  const stack = await startMediaStack('realm-create');
  try {
    const creator = await stack.member('realm-creator');
    await creator.grant('space:create:root', 'space.create');
    const topic = `https://rezics.com/id/${randomUUID()}`;
    await stack.fuseki.update(`PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(topic)} a skos:Concept ;
        skos:prefLabel "Fantasy"@en ; skos:prefLabel "奇幻"@zh-CN . } }`);
    const command = { profile: 'space-realm-v1', name: 'Fantasy Readers', handle: 'fantasy-readers',
      topics: [topic], capabilities: ['realm'], actingSubject: creator.actor };
    const created = await json<{ realm: string; owner: string }>(
      await creator.send('POST', '/v1/spaces', command), 201);
    expect(created.owner).toBe(creator.actor);
    expect(await json(await stack.call('GET', '/v1/realms/by-handle/fantasy-readers'), 200))
      .toEqual({ realm: created.realm, handle: command.handle });
    const selected = await json<{ topic: { id: string; label: { value: string } };
      items: Array<{ id: string; handle: string | null }> }>(
      await stack.call('GET', `/v1/realms?topic=${encodeURIComponent(topic)}&language=zh-CN`), 200);
    expect(selected.topic).toMatchObject({ id: topic, label: { value: '奇幻' } });
    expect(selected.items).toMatchObject([{ id: created.realm, handle: 'fantasy-readers' }]);
    expect((await stack.call('GET', `/v1/realms?topic=${encodeURIComponent(
      `https://rezics.com/id/${randomUUID()}`)}`)).status).toBe(400);
    expect((await creator.send('POST', '/v1/spaces', { ...command, name: 'Impersonator' })).status).toBe(400);
    expect((await stack.call('GET', '/v1/realms/by-handle/missing-handle')).status).toBe(404);
  } finally { await stack.stop(); }
});
