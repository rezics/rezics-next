import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { convertBangumi } from '@rezics/conversion/bangumi';
import { createImportTransport } from '../src/import-client.ts';
import { createMediaResolver } from '../src/media-resolver.ts';
import { RecordBindings } from '../src/record-bindings.ts';

for (const reply of [
  { fenced: false, securityRevision: 'contradiction' },
  { fenced: true, securityRevision: null },
]) {
  test(`public transport rejects incoherent fence evidence ${JSON.stringify(reply)}`, async () => {
    let requests = 0;
    const transport = createImportTransport({
      origin: 'https://api.rezics.test',
      tokenProvider: async () => 'fixture',
      fetch: (async (_input: RequestInfo | URL) => {
        requests++;
        return Response.json(reply);
      }) as typeof fetch,
    });
    await expect(transport.fence({ source: 'bangumi', externalId: '42', fieldGroup: 'cover' })).rejects.toBeInstanceOf(
      Error,
    );
    expect(requests).toBe(1);
  });
}

test('real bound media resolver rejects contradictory open evidence before preparing or posting', async () => {
  const db = new Database(':memory:');
  const bindings = new RecordBindings(db);
  const owner = { source: 'bangumi', external_id: '42' };
  const record = { id: 42, type: 1, name: 'Book', images: { large: 'https://lain.bgm.tv/pic/cover/l/42.jpg' } };
  const input = { external_id: '42', record_revision: '7', record };
  const bootstrap = convertBangumi(input, { source: 'bangumi' }).proposals[0]!;
  const subject = '00000000-0000-4000-8000-000000000101';
  let posts = 0,
    polls = 0;
  try {
    bindings.prepare(owner, 'fixture', { commands: [bootstrap] });
    bindings.acknowledge(owner, bootstrap.key, {
      results: [{ key: bootstrap.key, status: 201, value: { id: subject, revision: 1 } }],
    });
    const intents = convertBangumi(input, { source: 'bangumi', subjectId: subject }).mediaImportIntents;
    expect(intents).toHaveLength(1);
    const resolver = createMediaResolver({
      bindings,
      sleep: async () => {},
      port: {
        async readFence() {
          return { fenced: false, securityRevision: 'contradiction' };
        },
        async importFromUrl() {
          posts++;
          throw new Error('Media POST forbidden');
        },
        async importStatus() {
          polls++;
          throw new Error('Media status forbidden');
        },
      },
    });
    await expect(
      resolver.resolve({
        owner,
        containerId: subject,
        mediaImportIntents: intents,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(posts).toBe(0);
    expect(polls).toBe(0);
    expect(db.query('SELECT count(*) AS n FROM binding_media').get()).toEqual({ n: 0 });
    expect(bindings.claim(owner)).toEqual({ state: 'bound', subject });
  } finally {
    bindings.close();
    db.close();
  }
});
