import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { baselineProofCurrent, baselineTarget, newBaselineProof } from '../src/modules/access/baseline.ts';
import { ZONE_PAGE_CONTENT_PROOF, withZonePageContentTarget, zonePageContentAllowed } from '../src/modules/access/zone-content-authority.ts';

const zone = 'https://rezics.com/id/00000000-0000-4000-8000-000000000010';
const page = 'https://rezics.com/id/00000000-0000-4000-8000-000000000011';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000012';
const principalId = '00000000-0000-4000-8000-000000000013';
const receipt = `urn:rezics:receipt:${'ab'.repeat(32)}`;
const digest = 'cd'.repeat(32);

const controller = {
  policy_generation: '1', provision_id: '00000000-0000-4000-8000-000000000021',
  representation_id: '00000000-0000-4000-8000-000000000022', representation_generation: '2',
  subject_generation: '3', principal_epoch: '4', collection_create: false,
  related_work: null, source_revision: null, maintainer_generation: null,
};

function harness() {
  const state = { editor: false, email: true, author: false, owns: false, grant: '' };
  const sql: string[] = [];
  const sparql: string[] = [];
  const client = { query: async (query: string) => {
    sql.push(query);
    if (query.includes('access.policy')) return { rows: [], rowCount: 0 };
    if (query.includes('access.agent_provision')) return { rows: [controller], rowCount: 1 };
    if (query.includes('work_maintainer_set')) {
      return state.author ? { rows: [{ generation: '7', main_version: page, action: 'work.create',
        scope_id: 'work:create:root', creation_admission: '00000000-0000-4000-8000-000000000099',
        graph_receipt: receipt, request_digest: digest }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (query.includes('read_platform_permissions')) {
      return state.grant ? { rows: [{ id: '00000000-0000-4000-8000-000000000031',
        action: 'platform:resource:zone.edit', scope_id: state.grant, generation: '1',
        valid_until: null, witness: 'zone-edit' }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (query.includes("a.action = 'space.create'")) return { rows: state.editor ? [{}] : [], rowCount: state.editor ? 1 : 0 };
    throw new Error(`unexpected sql: ${query.slice(0, 160)}`);
  } };
  const graph = { query: async (query: string) => {
    sparql.push(query);
    if (query.includes('space:create:root')) {
      return state.editor ? { results: { bindings: [{ admission: { value: '00000000-0000-4000-8000-000000000014' },
        receipt: { value: receipt }, digest: { value: digest } }] } } : { results: { bindings: [] } };
    }
    if (query.includes('rv:Post') || query.includes('schema:CreativeWork')) return { boolean: true };
    if (query.includes('a rv:Zone')) return { boolean: state.owns };
    throw new Error(`unexpected sparql: ${query.slice(0, 180)}`);
  } };
  const request = (action: 'content.draft' | 'content.publish' | 'work.edit', resolved?: string, extra: Record<string, unknown> = {}) => {
    const scope = action === 'work.edit' ? `work:edit:${page}`
      : `${action === 'content.publish' ? 'content:publish' : 'content:draft'}:${page}`;
    const body = { principal: { issuer: 'https://account.test', subject: 'person', emailVerified: state.email },
      actingSubject: actor, scope, action, idempotencyKey: `${action}-1`, requestDigest: 'ef'.repeat(32), ...extra };
    return resolved === undefined ? body : withZonePageContentTarget(body, resolved);
  };
  return { state, sql, sparql, client: client as unknown as PoolClient, graph: graph as unknown as FusekiClient, request };
}

test('Work and Post content scopes stay on author authority', () => {
  expect(baselineTarget('content.draft', `content:draft:${page}`)).toEqual({ kind: 'reply-draft', id: page });
  expect(baselineTarget('content.publish', `content:publish:${page}`)).toEqual({ kind: 'author-work', id: page });
  expect(baselineTarget('content.search-eligibility', `content:search-eligibility:${page}`)).toEqual({ kind: 'author-work', id: page });
  expect(baselineTarget('work.edit', `work:edit:${page}`)).toEqual({ kind: 'author-work', id: page });
});

test('a Zone editor draft save and publish are admitted, and the editor can read the draft', async () => {
  const env = harness();
  env.state.editor = true;
  for (const action of ['content.draft', 'content.publish'] as const) {
    env.sql.length = 0;
    env.sparql.length = 0;
    const request = env.request(action, zone);
    const proof = await newBaselineProof(env.client, env.graph, request, principalId);
    expect(proof).toMatchObject({ realm_membership: ZONE_PAGE_CONTENT_PROOF, author_work: zone, author_generation: null });
    expect(env.sql.some(query => query.includes('work_maintainer_set'))).toBe(false);
    expect(await baselineProofCurrent(env.client, env.graph, proof!, {
      principal_id: principalId, acting_subject: actor, scope_id: request.scope, action })).toBe(true);
  }
  expect(await zonePageContentAllowed(env.client, env.graph, principalId, actor, zone, true)).toBe(true);
});

test('an unverified Zone steward cannot save or read a draft', async () => {
  const env = harness();
  env.state.editor = true;
  env.state.email = false;
  expect(await newBaselineProof(env.client, env.graph, env.request('content.draft', zone), principalId)).toBeNull();
  expect(await zonePageContentAllowed(env.client, env.graph, principalId, actor, zone, false)).toBe(false);
});

test('a non-editor cannot save, publish or read a Zone page draft', async () => {
  const env = harness();
  for (const action of ['content.draft', 'content.publish'] as const) {
    expect(await newBaselineProof(env.client, env.graph, env.request(action, zone), principalId)).toBeNull();
  }
  expect(await zonePageContentAllowed(env.client, env.graph, principalId, actor, zone, true)).toBe(false);
  expect(env.sql.some(query => query.includes('work_maintainer_set'))).toBe(false);
});

test('revoking the Zone editor before claim refuses the saved content draft', async () => {
  const env = harness();
  env.state.editor = true;
  const request = env.request('content.draft', zone);
  const proof = await newBaselineProof(env.client, env.graph, request, principalId);
  expect(proof?.author_work).toBe(zone);
  const admission = { principal_id: principalId, acting_subject: actor, scope_id: request.scope, action: 'content.draft' };
  expect(await baselineProofCurrent(env.client, env.graph, proof!, admission)).toBe(true);
  env.state.editor = false;
  expect(await baselineProofCurrent(env.client, env.graph, proof!, admission)).toBe(false);
});

test('a platform administrator with the zone.edit resource grant is admitted', async () => {
  const env = harness();
  env.state.email = false;
  env.state.grant = `zone:edit:${zone}`;
  const request = env.request('content.draft', zone);
  const proof = await newBaselineProof(env.client, env.graph, request, principalId);
  expect(proof).toMatchObject({ realm_membership: ZONE_PAGE_CONTENT_PROOF, author_work: zone });
  const admission = { principal_id: principalId, acting_subject: actor, scope_id: request.scope, action: 'content.draft' };
  expect(await baselineProofCurrent(env.client, env.graph, proof!, admission)).toBe(true);
  env.state.grant = '';
  expect(await baselineProofCurrent(env.client, env.graph, proof!, admission)).toBe(false);
});

test('a wildcard zone.edit grant still needs Zone or Space ownership', async () => {
  const env = harness();
  env.state.grant = 'zone:edit:*';
  const request = env.request('content.publish', zone);
  expect(await newBaselineProof(env.client, env.graph, request, principalId)).toBeNull();
  env.state.owns = true;
  const proof = await newBaselineProof(env.client, env.graph, request, principalId);
  expect(proof?.author_work).toBe(zone);
  expect(env.sparql.some(query => query.startsWith('PREFIX rv: <https://rezics.com/vocab/> ASK'))).toBe(true);
});

test('Work targets do not consult zone.edit', async () => {
  const env = harness();
  env.state.author = true;
  env.state.editor = true;
  for (const action of ['content.draft', 'content.publish'] as const) {
    env.sparql.length = 0;
    const proof = await newBaselineProof(env.client, env.graph, env.request(action), principalId);
    expect(proof).toMatchObject({ author_work: page, author_generation: '7', realm_membership: null });
    expect(env.sparql.some(query => query.includes('space:create:root'))).toBe(false);
  }
  env.sparql.length = 0;
  env.state.author = false;
  expect(await newBaselineProof(env.client, env.graph, env.request('work.edit', zone), principalId)).toBeNull();
  expect(env.sparql.some(query => query.includes('space:create:root'))).toBe(false);
  env.sql.length = 0;
  expect(await newBaselineProof(env.client, env.graph, env.request('content.draft', zone, {
    baselineRelatedWork: page }), principalId)).toBeNull();
  expect(env.sql).toEqual([]);
});
