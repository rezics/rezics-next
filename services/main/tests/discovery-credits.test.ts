import { expect, test } from 'bun:test';
import { namedDiscoveryCredits, primaryDiscoveryCredits } from '../src/modules/discovery/credits.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const field = (value: string) => ({ value });

test('discovery projects native and source credits with bounded order, then resolves current Agent names', async () => {
  const queried: string[] = [];
  const session = { query: async (body: string, limit: number) => {
    queried.push(body);
    if (body.includes('NativeAgentCredit')) {
      expect(limit).toBe(3);
      return [{ work: field(id(4)), id: field(id(1)), agent: field(id(2)) },
        { work: field(id(4)), id: field(id(3)), key: field('/authors/OL1A'), ordinal: field('2') }];
    }
    expect(limit).toBe(2);
    return [{ agent: field(id(2)), displayName: field('Jane Austen'), handle: field('agent-old') }];
  }, deps: { agentHandles: { current: async () => 'jane-austen' } } } as unknown as WorkReadSession;
  const credits = await primaryDiscoveryCredits(session, id(4));
  expect(credits).toHaveLength(2);
  expect(credits[0]).toMatchObject({ participantKind: 'agent', agent: id(2), displayName: null });
  expect(credits[1]).toMatchObject({ participantKind: 'external-reference', key: '/authors/OL1A',
    displayName: null });
  const named = await namedDiscoveryCredits(session, credits);
  expect(named.get(id(2))).toEqual({ displayName: 'Jane Austen', handle: 'jane-austen',
    address: { prefix: '/@', key: 'jane-austen', suffixSource: '' } });
  expect(queried[0]).toContain('ORDER BY ?ordinal STR(?id) LIMIT 3');
  expect(queried[1]).toContain('profileDisclosure rv:Private');
});
