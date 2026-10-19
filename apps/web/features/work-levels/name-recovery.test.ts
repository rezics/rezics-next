import { describe, expect, test } from 'bun:test';
import type { MainClient } from '../discover/types.ts';
import { animeRelationsReads } from '../work-page/anime-relations-recorded-page.ts';
import { iri, summary } from './fixtures.ts';
import type { Summary } from './types.ts';

describe('partial resource name recovery', () => {
  test('keeps successful sibling batches and retries the same position and resource identities', async () => {
    const resources = Array.from({ length: 130 }, (_, index) => iri(String(index)));
    let failed = true;
    const calls: { resources: string[]; position?: string; actingSubject?: string }[] = [];
    const main = { v1: { resources: { summaries: { post: async (body: typeof calls[number]) => {
      calls.push(body);
      if (body.resources[0] === resources[64] && failed) return { data: null, error: { status: 503 } };
      return { data: { summaries: body.resources.map(reference => summary(reference, `Name ${reference}`)) }, error: null };
    } } } } } as unknown as MainClient;
    const reads = animeRelationsReads({ main, actingSubject: iri('999'), signedIn: true });
    const before = await reads.namesOf(resources, 'selected-occurrence');
    expect(before.size).toBe(130);
    expect(before.get(resources[0]!)?.status).toBe('available');
    expect(before.get(resources[64]!)?.status).toBe('unavailable-read');
    expect(before.get(resources[129]!)?.status).toBe('available');
    failed = false;
    const after = await reads.namesOf(resources, 'selected-occurrence');
    expect([...after.values()].every(item => item.status === 'available')).toBe(true);
    expect(calls.slice(0, 3)).toEqual(calls.slice(3));
    expect(calls.every(call => call.position === 'selected-occurrence' && call.actingSubject === iri('999'))).toBe(true);
  });

  test('distinguishes withheld names from missing answers without inventing an unnamed result', async () => {
    const known = iri('1'); const hidden = iri('2'); const omitted = iri('3');
    const summaries: Summary[] = [summary(known, 'Known sibling'), { reference: hidden, status: 'unavailable' }];
    const main = { v1: { resources: { summaries: { post: async () => ({ data: { summaries }, error: null }) } } } } as unknown as MainClient;
    const names = await animeRelationsReads({ main }).namesOf([known, hidden, omitted]);
    expect(names.get(known)).toEqual(summaries[0]);
    expect(names.get(hidden)).toEqual(summaries[1]);
    expect(names.get(omitted)).toEqual({ reference: omitted, status: 'unavailable-read' });
  });
});
