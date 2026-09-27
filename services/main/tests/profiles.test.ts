import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { allocateAgentHandle, agentForHandle } from '../src/modules/agent/handle.ts';
import { nativeCreditDigest } from '../src/modules/profiles/credits.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid } from '../src/modules/work/read-session.ts';

test('G238: immutable handle allocation is injective, canonical and independent of private identity', () => {
  const ids = Array.from({ length: 1000 }, () => `https://rezics.com/id/${randomUUID()}`);
  const handles = ids.map(allocateAgentHandle);
  expect(new Set(handles).size).toBe(ids.length);
  handles.forEach((handle, index) => expect(agentForHandle(handle)).toBe(ids[index]!));
  expect(allocateAgentHandle(ids[0]!)).toBe(handles[0]!);
  expect(agentForHandle(handles[0]!.toUpperCase())).toBeNull();
  expect(agentForHandle('a-display-name')).toBeNull();
  expect(() => allocateAgentHandle('private-account')).toThrow();
});

test('G238: native credits preserve explicit Agent, role and Work basis in their intent', () => {
  const id = () => `https://rezics.com/id/${randomUUID()}`;
  const input = { work: id(), agent: id(), credit: id(), expectedWorkHead: id(), actingSubject: id(), role: 'author' as const };
  expect(nativeCreditDigest(input)).toBe(nativeCreditDigest({ ...input }));
  for (const field of ['work', 'agent', 'credit', 'expectedWorkHead', 'actingSubject'] as const) {
    expect(nativeCreditDigest({ ...input, [field]: id() })).not.toBe(nativeCreditDigest(input));
  }
  expect(nativeCreditDigest({ ...input, role: 'translator' })).not.toBe(nativeCreditDigest(input));
  expect(() => nativeCreditDigest({ ...input, agent: '/authors/OL1A' })).toThrow(WorkReadInvalid);
});

test('G238: library cursors cannot cross principal, actor, language or collection', () => {
  const position = { dataEpoch: 'one', sequence: '12' };
  const binding = ['profiles-v1', 'ratings', ['private-principal', 'pen-name', 'generation'], 'en'];
  const cursor = encodeReadCursor(binding, position, 'private-observation');
  expect(cursor).not.toContain('private');
  expect(decodeReadCursor(cursor, binding, position)?.after).toBe('private-observation');
  for (const changed of [ ['profiles-v1', 'contributions', binding[2], 'en'],
    ['profiles-v1', 'ratings', ['other-principal', 'pen-name', 'generation'], 'en'],
    ['profiles-v1', 'ratings', ['private-principal', 'other-agent', 'generation'], 'en'],
    ['profiles-v1', 'ratings', binding[2], 'ja'] ]) {
    expect(() => decodeReadCursor(cursor, changed, position)).toThrow(WorkReadInvalid);
  }
});

test('G238: profiles and library have concrete web-style treaty response types', () => {
  const client = treaty<MainApp>('http://main.invalid');
  const consume = async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const agent = await client.v1.agents({ id }).get();
    const handle: string | undefined = agent.data?.handle;
    const visible: boolean | undefined = agent.data?.library.statusShelvesVisible;
    const resolved = await client.v1.handles({ handle: `agent-${id}` }).get();
    const name: string | undefined = resolved.data?.displayName;
    const works = await client.v1.agents({ id }).works.get({ query: { limit: 1 } });
    const role: 'author' | 'translator' | 'editor' | undefined = works.data?.items[0]?.attribution[0]?.role;
    const shelves = await client.v1.agents({ id }).collections.get();
    const kind: 'static' | 'captured' | undefined = shelves.data?.items[0]?.kind;
    const statusShelf = await client.v1.agents({ id }).shelves.status({ status: 'reading' }).works.get();
    const statusCount: number | undefined = statusShelf.data?.statusCount;
    const drafts = await client.v1.me.contributions.get({ query: { actingSubject: `https://rezics.com/id/${id}` } });
    const revision: string | undefined = drafts.data?.items[0]?.revision;
    const ratings = await client.v1.me.ratings.get({ query: { actingSubject: `https://rezics.com/id/${id}`, scope: 'global' } });
    const value: number | null | undefined = ratings.data?.items[0]?.value;
    const credits = await client.v1.works({ id })['agent-credits'].get();
    const credited: string | undefined = credits.data?.items[0]?.agent;
    return { handle, visible, name, role, kind, statusCount, revision, value, credited };
  };
  expect(consume).toBeFunction();
});
