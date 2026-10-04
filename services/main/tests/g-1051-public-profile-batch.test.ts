import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { PersonPreferencesStore } from '../src/modules/preferences/store.ts';

const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';

test('G1051: a partial, repeated, foreign or unfenced public policy result cannot disclose an Agent', async () => {
  for (const rows of [
    [],
    [{ agent, open: false, visible: true }],
    [{ agent, open: true, visible: null }],
    [{ agent: agent.replace(/1$/, '2'), open: true, visible: true }],
    [
      { agent, open: true, visible: true },
      { agent, open: true, visible: true },
    ],
  ]) {
    const owner = new PersonPreferencesStore({ query: async () => ({ rows }) } as unknown as Pool);
    await expect(owner.publicDiscoveryProfiles([agent])).rejects.toThrow('unavailable');
  }
});
