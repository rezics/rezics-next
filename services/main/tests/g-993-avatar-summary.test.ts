import { expect, test } from 'bun:test';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { readResourceSummaries } from '../src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT, type AvatarRow, type MediaStore } from '../src/modules/media/store.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const agent = id(1), work = id(2), selection = id(11).slice(-36);
const literal = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });

const avatar = (target: string): AvatarRow => ({
  target, context: DEFAULT_MEDIA_CONTEXT, selection, selectionPosition: '1',
  use: id(12).slice(-36), asset: id(13).slice(-36), crop: null,
  representation: id(14).slice(-36), sha256: 'a'.repeat(64), mediaType: 'image/png',
  byteLength: 100, width: 128, height: 128, availability: 'available',
  clearance: 'cleared', disclosure: 'public', moderation: 'none', lifecycle: 'active', statePosition: '1',
});

for (const [name, references, kind] of [
  ['not adopted or cleared', [], 'fallback'],
  ['another selection', [id(15).slice(-36)], 'fallback'],
  ['ambiguous selection', [selection, id(15).slice(-36)], 'fallback'],
  ['adopted selection', [selection], 'image'],
  ['repeated graph binding', [selection, selection], 'image'],
] as const) {
  test(`G-993: Agent summaries follow the current profile avatar (${name})`, async () => {
    let graphQueries = 0, mediaQueries = 0;
    const agentRow = { epoch: literal('epoch'), sequence: literal('7'), r: uri(agent),
      type: literal('agent'), public: literal('true'), label: literal('Agent') };
    const bindings: NonNullable<SparqlResult['results']>['bindings'] = [
      ...(references.length ? references.map(value => ({ ...agentRow, profileAvatarSelection: literal(value) }))
        : [agentRow]),
      { epoch: literal('epoch'), sequence: literal('7'), r: uri(work), work: uri(work),
        head: uri(id(20)), type: literal('work'), public: literal('true'),
        label: { ...literal('Work'), 'xml:lang': 'en' } },
    ];
    const environment = { lineage: { dataEpoch: 'epoch', routingEpoch: '1' }, fuseki: {
      query: async () => { graphQueries++; return { results: { bindings } }; },
    } } as unknown as WorkActivationEnvironment;
    const media = { avatarRows: async (targets: readonly string[]) => {
      mediaQueries++;
      expect(targets).toEqual([agent, work]);
      return { rows: new Map([[agent, avatar(agent)], [work, avatar(work)]]),
        generation: { dataEpoch: 'media', sequence: '3' } };
    } } as unknown as MediaStore;
    const result = await readResourceSummaries(environment, media, {}, {
      resources: [agent, work], context: DEFAULT_MEDIA_CONTEXT, language: 'en',
    });
    expect(result.summaries[0]).toMatchObject({ status: 'available', avatar: { kind } });
    expect(result.summaries[1]).toMatchObject({ status: 'available', avatar: { kind: 'image', selection } });
    expect({ graphQueries, mediaQueries }).toEqual({ graphQueries: 1, mediaQueries: 1 });
    expect(result.cost).toMatchObject({ graphQueries: 1, mediaQueries: 1 });
  });
}
