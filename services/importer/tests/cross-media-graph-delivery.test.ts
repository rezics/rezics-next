import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { CrossMediaGraph, graphEdgeCommandKey, type GraphEdgeDraft } from '../src/cross-media-bindings.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('graph delivery keeps sealed order and skips acknowledged proposal pages on reopen', async () => {
  const db = new Database(':memory:');
  try {
    const graph = new CrossMediaGraph(db);
    const drafts: GraphEdgeDraft[] = Array.from({ length: 66 }, (_, i) => ({
      source: 'vndb',
      alias: 'vndb_cross_media',
      table: 'releases_vn',
      holder: `r${i + 100}`,
      target: 'v1',
      property: 'schema:exampleOfWork',
      url: `https://vndb.org/r${i + 100}`,
      membership: 'referenced',
      record: { id: `r${i + 100}`, vid: 'v1', rtype: 'complete' },
      fields: ['releases_vn.id'],
    }));
    graph.remember(drafts);
    const keys = graph.planned().map(graphEdgeCommandKey);
    const pages: string[][] = [];
    let interrupted = true;
    const deadline = new Error('fixture transport interrupted');
    const deliver = () =>
      graph.deliver({
        claim: ({ external_id }) => ({ state: 'bound', subject: id(Number(external_id.slice(1))) }),
        nativeType: () => undefined,
        currentRelationEndpoint: async () => 'current',
        fence: async () => ({ fenced: false, securityRevision: null }),
        async batch({ commands }) {
          pages.push(commands.map(({ key }) => key));
          if (interrupted && pages.length === 2) throw deadline;
          return {
            results: commands.map(({ key }) => ({
              key,
              status: 201,
              value: { candidate: id(keys.indexOf(key) + 200), revision: 1 },
            })),
          };
        },
      });
    await expect(deliver()).rejects.toBe(deadline);
    expect(pages).toEqual([keys.slice(0, 32), keys.slice(32, 64)]);
    interrupted = false;
    await deliver();
    expect(pages.slice(2)).toEqual([keys.slice(32, 64), keys.slice(64)]);
    expect(graph.planned()).toEqual([]);
  } finally {
    db.close();
  }
});
