import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { WORK_READ_COST } from '../../../services/main/src/modules/work/read-contract.ts';
import { configureDisclosure, DisclosureStore } from '../../../services/main/src/modules/disclosure/read.ts';
import { startHomeStack } from './feed-read-support.ts';

test('G-908: 10 and 100 Collection members use the same graph query count with budget headroom', async () => {
  const home = await startHomeStack('g-908-collection');
  try {
    const actor = await home.provision('Collection page owner', home.author.token);
    const target = await home.stack.publicWork(actor);
    const collection = `https://rezics.com/id/${randomUUID()}`;
    const created = await home.json<{ structure: string; revision: string }>(await home.call('POST', '/v1/collections',
      { collection, name: 'Collection page', disclosure: 'public', actingSubject: actor }, home.author.token), 201);
    let head = created.revision;
    const expected: string[] = [];
    for (let start = 0; start < 100; start += 16) {
      const changed = await home.json<{ revision: string; occurrences: string[] }>(await home.call('POST',
        `/v1/collections/${collection.slice(-36)}/changes`, { actingSubject: actor, expectedHead: head,
          operations: Array.from({ length: Math.min(16, 100 - start) }, () => ({ op: 'insert', role: 'member',
            parent: created.structure, position: 'last', target: target.work, selection: { mode: 'follow-context' } })) },
        home.author.token));
      head = changed.revision;
      expected.push(...changed.occurrences);
    }
    configureDisclosure(home.stack.env, new DisclosureStore(home.stack.accessPool));
    const counts: number[] = [];
    for (const limit of [10, 100]) {
      const before = home.stack.fuseki.queries;
      const query = new URLSearchParams({ actingSubject: actor, limit: String(limit) });
      const page = await home.json<{ occurrences: { occurrence: string; target: string }[]; next: string | null }>(
        await home.call('GET', `/v1/collections/${collection.slice(-36)}?${query}`, undefined, home.author.token));
      counts.push(home.stack.fuseki.queries - before);
      expect(page.occurrences.map(row => row.occurrence)).toEqual(expected.slice(0, limit));
      expect(page.occurrences.every(row => row.target === target.work)).toBe(true);
      expect(page.next === null).toBe(limit === 100);
    }
    expect(counts[1]).toBe(counts[0]);
    expect(counts[1]).toBeLessThanOrEqual(WORK_READ_COST.graphCalls / 4);
    console.log(`G-908 Collection graph queries: 10 members=${counts[0]}, 100 members=${counts[1]}`);

    const other = await home.stack.publicWork(actor);
    const changed = await home.json<{ occurrences: string[] }>(await home.call('POST',
      `/v1/collections/${collection.slice(-36)}/changes`, { actingSubject: actor, expectedHead: head,
        operations: [{ op: 'insert', role: 'member', parent: created.structure, position: 'last', target: other.work }] },
      home.author.token));
    // Interactive reads retain rated catalogue members; clients apply category
    // presentation. Ratings do not replace the service's private/removal gates.
    const assessment = randomUUID();
    await home.stack.accessPool.query(`INSERT INTO access.suitability_assessment
      (id,target,labels,basis,assessor,principal_id,revision_number,authority_proof,idempotency_key,request_digest)
      VALUES ($1,$2,'{r18}','author',$3,$4,1,'{}',$5,$6)`,
    [assessment, target.work, actor, home.author.principalId, randomUUID(), 'a'.repeat(64)]);
    const path = `/v1/collections/${collection.slice(-36)}`;
    for (const signed of [false, true]) {
      const query = new URLSearchParams({ limit: '100', ...(signed ? { actingSubject: actor } : {}) });
      const page = await home.json<{ occurrences: { occurrence: string; target: string }[]; next: string | null }>(
        await home.call('GET', `${path}?${query}`, undefined, signed ? home.author.token : undefined));
      expect(page.occurrences.map(row => row.occurrence)).toEqual(expected);
      expect(page.occurrences.every(row => row.target === target.work)).toBe(true);
      expect(page.next).not.toBeNull();
      const last = await home.json<{ occurrences: { occurrence: string; target: string }[]; next: string | null }>(
        await home.call('GET', `${path}?${query}&after=${encodeURIComponent(page.next!)}`,
          undefined, signed ? home.author.token : undefined));
      expect(last.occurrences.map(row => row.occurrence)).toEqual(changed.occurrences);
      expect(last.occurrences.map(row => row.target)).toEqual([other.work]);
      expect(last.next).toBeNull();
    }
    await home.stack.accessPool.query(`INSERT INTO access.suitability_assessment
      (id,target,labels,basis,assessor,principal_id,predecessor,predecessor_number,revision_number,
        authority_proof,idempotency_key,request_digest)
      VALUES ($1,$2,'{}','author',$3,$4,$5,1,2,'{}',$6,$7)`,
    [randomUUID(), target.work, actor, home.author.principalId, assessment, randomUUID(), 'b'.repeat(64)]);
    const recovered = await home.json<{ occurrences: { occurrence: string }[]; next: string | null }>(
      await home.call('GET', `${path}?limit=100`));
    expect(recovered.occurrences.map(row => row.occurrence)).toEqual(expected);
    expect(recovered.next).not.toBeNull();
  } finally { await home.stop(); }
}, 300_000);
