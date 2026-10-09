import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { ContentErasureInvalid } from '../src/modules/erasure/content.ts';
import { canonicalErasureTargets } from '../src/modules/erasure/graph.ts';
import { ERASURE_REVISION_RESOURCES, resolveErasureRevisions,
  type ResolvedErasureRevision } from '../src/modules/erasure/revision-kind.ts';

const uuid = (ordinal: number) => `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
const resource = (ordinal: number) => `https://rezics.com/id/${uuid(ordinal)}`;

function content(rows: { id: string; resource_id: string; availability: string }[]) {
  return { query: async () => ({ rows }) } as unknown as Pick<Pool, 'query'>;
}

function graph(rows: { revision: string; kind: string; owner: string; erased?: boolean }[],
  seen: string[] = []) {
  return { query: async (sparql: string) => {
    seen.push(sparql);
    return { results: { bindings: rows.filter(row => sparql.includes(`<${row.revision}>`)).map(row => ({
      revision: { type: 'uri' as const, value: row.revision },
      kind: { type: 'literal' as const, value: row.kind },
      owner: { type: 'uri' as const, value: row.owner },
      erased: { type: 'literal' as const, value: row.erased ? 'true' : 'false' },
    })) } };
  } } as unknown as Pick<FusekiClient, 'query'>;
}

const kinds = [
  ['text_contribution_draft', 'TextContribution', 'text-contribution'],
  ['semantic_revision', 'SemanticRevision', 'semantic-component'],
  ['release_revision', 'ReleaseRevision', 'release'],
  ['work_head', 'CreativeWork', 'work'],
  ['composition_revision', 'StructureRevision', 'structure'],
] as const;

test('each graph revision kind resolves to its owner resource', async () => {
  for (const [kind, type, ownerKind] of kinds) {
    const seen: string[] = [];
    const owner = resource(1);
    const revision = resource(2);
    const resolved = await resolveErasureRevisions(content([]), graph([{
      revision, kind, owner }], seen), owner, [uuid(2)]);
    expect(resolved).toEqual([{ kind, ref: uuid(2), resourceId: owner,
      graphIri: revision, erased: false } satisfies ResolvedErasureRevision]);
    expect(seen[0]).toContain(type);
    expect(seen[0]).toContain('FixedRelease');
    expect(ERASURE_REVISION_RESOURCES[kind]).toBe(ownerKind);
  }
});

test('a content revision resolves from its variant owner without a graph read', async () => {
  const seen: string[] = [];
  const owner = resource(3);
  const resolved = await resolveErasureRevisions(content([{ id: uuid(4), resource_id: owner,
    availability: 'available' }]), graph([], seen), owner, [uuid(4)]);
  expect(resolved).toEqual([{ kind: 'content_revision', ref: uuid(4), resourceId: owner,
    graphIri: `urn:rezics:content:revision:${uuid(4)}`, erased: false }]);
  expect(seen).toEqual([]);
  expect(ERASURE_REVISION_RESOURCES.content_revision).toBe('work');
});

test('the wrong owner and an unknown revision are refused', async () => {
  const owner = resource(5);
  const other = resource(6);
  await expect(resolveErasureRevisions(content([{ id: uuid(7), resource_id: other,
    availability: 'available' }]), graph([]), owner, [uuid(7)]))
    .rejects.toBeInstanceOf(ContentErasureInvalid);
  await expect(resolveErasureRevisions(content([]), graph([{ revision: resource(8),
    kind: 'work_head', owner: other }]), owner, [uuid(8)]))
    .rejects.toBeInstanceOf(ContentErasureInvalid);
  await expect(resolveErasureRevisions(content([]), graph([]), owner, [uuid(9)]))
    .rejects.toBeInstanceOf(ContentErasureInvalid);
  await expect(resolveErasureRevisions(content([]), graph([
    { revision: resource(10), kind: 'work_head', owner },
    { revision: resource(10), kind: 'release_revision', owner },
  ]), owner, [uuid(10)])).rejects.toBeInstanceOf(ContentErasureInvalid);
});

test('an already erased revision resolves to the same identity', async () => {
  const owner = resource(11);
  const revision = resource(12);
  const read = () => resolveErasureRevisions(content([]), graph([{ revision, kind: 'work_head', owner,
    erased: true }]), owner, [uuid(12)]);
  const first = await read();
  const second = await read();
  expect(second).toEqual(first);
  expect(first).toEqual([{ kind: 'work_head', ref: uuid(12), resourceId: owner, graphIri: revision,
    erased: true }]);
  const stored = await resolveErasureRevisions(content([{ id: uuid(13), resource_id: owner,
    availability: 'erased' }]), graph([]), owner, [uuid(13)]);
  expect(stored[0]!.erased).toBe(true);
  expect(await resolveErasureRevisions(content([{ id: uuid(13), resource_id: owner,
    availability: 'erased' }]), graph([]), owner, [uuid(13)])).toEqual(stored);
});

test('one request can name a Content revision and its Work head', async () => {
  const owner = resource(30);
  const head = resource(31);
  const resolved = await resolveErasureRevisions(content([{ id: uuid(32), resource_id: owner,
    availability: 'available' }]), graph([{ revision: head, kind: 'work_head', owner }]),
  owner, [uuid(32), uuid(31)]);
  expect(resolved.map(item => item.kind)).toEqual(['content_revision', 'work_head']);
  expect(resolved.every(item => item.resourceId === owner && !item.erased)).toBe(true);
});

test('tombstone digests keep Content revision URNs and accept graph revision IRIs', () => {
  const first = uuid(20);
  const second = uuid(21);
  expect(canonicalErasureTargets([second, first])).toEqual([
    `urn:rezics:content:revision:${first}`, `urn:rezics:content:revision:${second}`]);
  const revision = resource(22);
  expect(canonicalErasureTargets([revision, first])).toEqual([
    revision, `urn:rezics:content:revision:${first}`]);
  expect(() => canonicalErasureTargets([`urn:rezics:content:revision:${first}`])).toThrow();
});
