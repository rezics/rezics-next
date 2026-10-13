import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { AccessAdmissionRegistry, AdmissionUnavailable } from '../src/modules/access/admission.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import {
  baselineProofCurrent,
  baselineTarget,
  newBaselineProof,
} from '../src/modules/access/baseline.ts';
import {
  ZONE_PAGE_CONTENT_PROOF,
  withZonePageContentTarget,
  zonePageContentAllowed,
  resolveZonePageContent,
  zonePageAdministratorAllowed,
  zoneEditScope,
} from '../src/modules/access/zone-content-authority.ts';
import {
  platformAdministratorProof,
  platformAdministratorProofCurrent,
} from '../src/modules/access/platform-administrator.ts';

const zone = 'https://rezics.com/id/00000000-0000-4000-8000-000000000010';
const page = 'https://rezics.com/id/00000000-0000-4000-8000-000000000011';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000012';
const principalId = '00000000-0000-4000-8000-000000000013';
const receipt = `urn:rezics:receipt:${'ab'.repeat(32)}`;
const digest = 'cd'.repeat(32);

function navigationDisclosure() {
  const publicCollection = page, privateCollection = zone, work = actor;
  const state = { recovery: true, closed: false, policy: false, public: true, ambiguous: false };
  const queries: string[] = [], semanticBatches: string[][] = [];
  const client = { release() {}, query: async (sql: string, values: unknown[] = []) => {
    if (sql.includes('access.recovery_fence')) return { rows: [{ open: state.recovery }] };
    if (sql.includes('SELECT wanted.resource')) return { rows: state.closed || state.policy ? []
      : (values[0] as string[]).map(resource => ({ resource })) };
    return { rows: [] };
  } } as unknown as PoolClient;
  const access = new AccessAdmissionRegistry({ connect: async () => client } as unknown as Pool);
  access.configureBaseline({ query: async query => {
    queries.push(query);
    const uri = (value: string) => ({ type: 'uri' as const, value });
    const collection = { resource: uri(publicCollection), publicCollection: { type: 'literal' as const, value: 'true' } };
    return { results: { bindings: [{ resource: uri(work) }, ...(state.public ? [collection] : []),
      ...(state.ambiguous ? [collection] : [])] } };
  } });
  access.canReadSemanticResources = async (_principal, _actor, resources) => {
    semanticBatches.push([...resources]);
    return new Set();
  };
  access.canReadWorks = async (_principal, _actor, works) => new Set(works);
  const principal = { issuer: 'https://account.test', subject: 'operator' };
  const read = (workScope = true) => access.canReadZoneNavigationTargets(principal,
    workScope ? principal : null, actor, [publicCollection, privateCollection, work, publicCollection]);
  return { read, state, queries, semanticBatches, publicCollection, privateCollection, work };
}

test('Zone target pages consume public Collection disclosure without granting private target reads', async () => {
  const f = navigationDisclosure();
  expect(await f.read()).toEqual(new Set([f.publicCollection, f.work]));
  expect(f.semanticBatches).toEqual([[f.privateCollection]]);
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]).toContain('rv:collectionState rv:Active ; rv:disclosure rv:Public');
  expect(f.queries[0]).toContain('rv:structureOf ?resource');
  expect(f.queries[0]).toContain('rv:protectionHead');
  expect(f.queries[0]).toContain('rv:ErasedRevision');
  expect(f.queries[0]).toContain('LIMIT 4');
  expect(await f.read(false)).toEqual(new Set([f.publicCollection]));
  f.state.public = false;
  expect(await f.read(false)).toEqual(new Set());
});

test('public Collection navigation retains independent scope, policy, recovery and ambiguity refusals', async () => {
  const f = navigationDisclosure();
  f.state.closed = true;
  expect(await f.read()).toEqual(new Set([f.work]));
  f.state.closed = false;
  f.state.policy = true;
  expect(await f.read()).toEqual(new Set([f.work]));
  f.state.policy = false;
  f.state.ambiguous = true;
  await expect(f.read()).rejects.toBeInstanceOf(AdmissionUnavailable);
  f.state.ambiguous = false;
  f.state.recovery = false;
  await expect(f.read()).rejects.toBeInstanceOf(AdmissionUnavailable);
});

const controller = {
  policy_generation: '1',
  provision_id: '00000000-0000-4000-8000-000000000021',
  representation_id: '00000000-0000-4000-8000-000000000022',
  representation_generation: '2',
  subject_generation: '3',
  principal_epoch: '4',
  collection_create: false,
  related_work: null,
  source_revision: null,
  maintainer_generation: null,
};

function harness() {
  const state = {
    editor: false,
    email: true,
    author: false,
    owns: false,
    grant: '',
    grants: [] as string[],
    administrator: true,
    provision: true,
    control: true,
    grantGeneration: '1',
  };
  const sql: string[] = [];
  const sparql: string[] = [];
  const client = {
    query: async (query: string, values: unknown[] = []) => {
      sql.push(query);
      if (query.includes('access.policy')) return { rows: [], rowCount: 0 };
      if (query.includes('access.agent_provision'))
        return { rows: state.provision ? [controller] : [], rowCount: state.provision ? 1 : 0 };
      if (query.includes('access.scope_gate'))
        return { rows: [{ open: true, dispatch_open: true }], rowCount: 1 };
      if (query.includes('SELECT $3::text AS receipt'))
        return {
          rows: state.control
            ? [
                {
                  ...controller,
                  receipt: values[2],
                },
              ]
            : [],
          rowCount: state.control ? 1 : 0,
        };
      if (query.includes('work_maintainer_set')) {
        return state.author
          ? {
              rows: [
                {
                  generation: '7',
                  main_version: page,
                  action: 'work.create',
                  scope_id: 'work:create:root',
                  creation_admission: '00000000-0000-4000-8000-000000000099',
                  graph_receipt: receipt,
                  request_digest: digest,
                },
              ],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      if (query.includes('read_platform_permissions')) {
        return {
          rows: [
            ...(state.administrator
              ? [
                  {
                    id: '00000000-0000-4000-8000-000000000030',
                    action: 'platform:use:platform-admin',
                    scope_id: 'platform:access',
                    generation: '1',
                    valid_until: null,
                    witness: 'platform-admin',
                  },
                ]
              : []),
            ...(state.grants.length ? state.grants : state.grant ? [state.grant] : []).map(
              (scope, index) => ({
                id: `00000000-0000-4000-8000-${String(31 + index).padStart(12, '0')}`,
                action: 'platform:resource:zone.edit',
                scope_id: scope,
                generation: '1',
                valid_until: null,
                witness: `zone-edit:${state.grantGeneration}`,
              }),
            ),
          ],
        };
      }
      if (query.includes("a.action = 'space.create'"))
        return { rows: state.editor ? [{}] : [], rowCount: state.editor ? 1 : 0 };
      throw new Error(`unexpected sql: ${query.slice(0, 160)}`);
    },
  };
  const graph = {
    query: async (query: string) => {
      sparql.push(query);
      if (query.includes('space:create:root')) {
        return state.editor
          ? {
              results: {
                bindings: [
                  {
                    admission: { value: '00000000-0000-4000-8000-000000000014' },
                    receipt: { value: receipt },
                    digest: { value: digest },
                  },
                ],
              },
            }
          : { results: { bindings: [] } };
      }
      if (query.includes('rv:Post') || query.includes('schema:CreativeWork'))
        return { boolean: true };
      if (query.includes('a rv:Zone')) return { boolean: state.owns };
      throw new Error(`unexpected sparql: ${query.slice(0, 180)}`);
    },
  };
  const request = (
    action: 'content.draft' | 'content.publish' | 'work.edit',
    resolved?: string,
    extra: Record<string, unknown> = {},
  ) => {
    const scope =
      action === 'work.edit'
        ? `work:edit:${page}`
        : `${action === 'content.publish' ? 'content:publish' : 'content:draft'}:${page}`;
    const body = {
      principal: { issuer: 'https://account.test', subject: 'person', emailVerified: state.email },
      actingSubject: actor,
      scope,
      action,
      idempotencyKey: `${action}-1`,
      requestDigest: 'ef'.repeat(32),
      ...extra,
    };
    return resolved === undefined ? body : withZonePageContentTarget(body, resolved);
  };
  return {
    state,
    sql,
    sparql,
    client: client as unknown as PoolClient,
    graph: graph as unknown as FusekiClient,
    request,
  };
}

test('Work and Post content scopes stay on author authority', () => {
  expect(baselineTarget('content.draft', `content:draft:${page}`)).toEqual({
    kind: 'reply-draft',
    id: page,
  });
  expect(baselineTarget('content.publish', `content:publish:${page}`)).toEqual({
    kind: 'author-work',
    id: page,
  });
  expect(
    baselineTarget('content.search-eligibility', `content:search-eligibility:${page}`),
  ).toEqual({ kind: 'author-work', id: page });
  expect(baselineTarget('work.edit', `work:edit:${page}`)).toEqual({
    kind: 'author-work',
    id: page,
  });
});

test('a Zone editor draft save and publish are admitted, and the editor can read the draft', async () => {
  const env = harness();
  env.state.editor = true;
  for (const action of ['content.draft', 'content.publish'] as const) {
    env.sql.length = 0;
    env.sparql.length = 0;
    const request = env.request(action, zone);
    const proof = await newBaselineProof(env.client, env.graph, request, principalId);
    expect(proof).toMatchObject({
      realm_membership: ZONE_PAGE_CONTENT_PROOF,
      author_work: zone,
      author_generation: null,
    });
    expect(env.sql.some((query) => query.includes('work_maintainer_set'))).toBe(false);
    expect(
      await baselineProofCurrent(env.client, env.graph, proof!, {
        principal_id: principalId,
        acting_subject: actor,
        scope_id: request.scope,
        action,
      }),
    ).toBe(true);
  }
  expect(await zonePageContentAllowed(env.client, env.graph, principalId, actor, zone, true)).toBe(
    true,
  );
});

test('an unverified Zone steward cannot save or read a draft', async () => {
  const env = harness();
  env.state.editor = true;
  env.state.email = false;
  expect(
    await newBaselineProof(env.client, env.graph, env.request('content.draft', zone), principalId),
  ).toBeNull();
  expect(await zonePageContentAllowed(env.client, env.graph, principalId, actor, zone, false)).toBe(
    false,
  );
});

test('a non-editor cannot save, publish or read a Zone page draft', async () => {
  const env = harness();
  for (const action of ['content.draft', 'content.publish'] as const) {
    expect(
      await newBaselineProof(env.client, env.graph, env.request(action, zone), principalId),
    ).toBeNull();
  }
  expect(await zonePageContentAllowed(env.client, env.graph, principalId, actor, zone, true)).toBe(
    false,
  );
  expect(env.sql.some((query) => query.includes('work_maintainer_set'))).toBe(false);
});

test('revoking the Zone editor before claim refuses the saved content draft', async () => {
  const env = harness();
  env.state.editor = true;
  const request = env.request('content.draft', zone);
  const proof = await newBaselineProof(env.client, env.graph, request, principalId);
  expect(proof?.author_work).toBe(zone);
  const admission = {
    principal_id: principalId,
    acting_subject: actor,
    scope_id: request.scope,
    action: 'content.draft',
  };
  expect(await baselineProofCurrent(env.client, env.graph, proof!, admission)).toBe(true);
  env.state.editor = false;
  expect(await baselineProofCurrent(env.client, env.graph, proof!, admission)).toBe(false);
});

test('a platform administrator uses a pinned grant and live controller without an Agent provision', async () => {
  const env = harness();
  env.state.email = false;
  env.state.provision = false;
  env.state.grant = `zone:edit:${zone}`;
  const proof = await platformAdministratorProof(env.client, principalId, actor, true, {
    action: 'zone.edit',
    scope: zoneEditScope(zone),
  });
  expect(proof).not.toBeNull();
  expect(env.sql.some((query) => query.includes('access.agent_provision'))).toBe(false);
  const saved = { ...proof!, resolved_zone_page: zone };
  expect(
    await zonePageAdministratorAllowed(
      env.client,
      env.graph,
      principalId,
      actor,
      saved,
      'content.draft',
    ),
  ).toBe(true);
  expect(await platformAdministratorProofCurrent(env.client, saved, principalId, actor)).toBe(true);
  env.sql.length = 0;
  env.sparql.length = 0;
  expect(await zonePageContentAllowed(env.client, env.graph, principalId, actor, zone, false)).toBe(
    true,
  );
  expect(env.sql.filter((query) => query.includes('read_platform_permissions'))).toHaveLength(2);
  expect(env.sql.filter((query) => query.includes('SELECT $3::text AS receipt'))).toHaveLength(1);
  expect(env.sql.some((query) => query.includes('access.agent_provision'))).toBe(false);
  expect(env.sparql).toEqual([]);
  env.state.grant = '';
  expect(
    await zonePageAdministratorAllowed(
      env.client,
      env.graph,
      principalId,
      actor,
      saved,
      'content.draft',
    ),
  ).toBe(false);
  expect(await platformAdministratorProofCurrent(env.client, saved, principalId, actor)).toBe(
    false,
  );
  env.state.grant = zoneEditScope(zone);
  env.state.grantGeneration = '2';
  expect(await platformAdministratorProofCurrent(env.client, saved, principalId, actor)).toBe(
    false,
  );
  env.state.control = false;
  expect(await zonePageContentAllowed(env.client, env.graph, principalId, actor, zone, false)).toBe(
    false,
  );
});

test('a wildcard zone.edit grant still needs Zone or Space ownership', async () => {
  const env = harness();
  env.state.grant = 'zone:edit:*';
  const saved = { resolved_zone_page: zone };
  expect(
    await zonePageAdministratorAllowed(
      env.client,
      env.graph,
      principalId,
      actor,
      saved,
      'content.publish',
    ),
  ).toBe(false);
  env.state.owns = true;
  expect(
    await zonePageAdministratorAllowed(
      env.client,
      env.graph,
      principalId,
      actor,
      saved,
      'content.publish',
    ),
  ).toBe(true);
  expect(
    env.sparql.some((query) => query.startsWith('PREFIX rv: <https://rezics.com/vocab/> ASK')),
  ).toBe(true);
});

test('Zone content uses the exact mandate in either grant order and fences its saved proof', async () => {
  for (const grants of [['zone:edit:*', zoneEditScope(zone)], [zoneEditScope(zone), 'zone:edit:*']]) {
    const env = harness();
    env.state.grants = grants;
    const saved = await platformAdministratorProof(env.client, principalId, actor, true, {
      action: 'zone.edit', scope: zoneEditScope(zone),
    });
    expect(saved).not.toBeNull();
    expect(await platformAdministratorProofCurrent(env.client, saved!, principalId, actor)).toBe(true);
    for (const action of ['content.draft', 'content.publish']) {
      expect(await zonePageAdministratorAllowed(env.client, env.graph, principalId, actor,
        { ...saved!, resolved_zone_page: zone }, action)).toBe(true);
    }
    env.sql.length = 0;
    expect(await zonePageContentAllowed(env.client, env.graph, principalId, actor, zone, false)).toBe(true);
    expect(env.sql.filter(query => query.includes('read_platform_permissions'))).toHaveLength(2);
    expect(env.sparql).toEqual([]);
    env.state.grants = ['zone:edit:*'];
    expect(await zonePageAdministratorAllowed(env.client, env.graph, principalId, actor,
      { ...saved!, resolved_zone_page: zone }, 'content.publish')).toBe(false);
    expect(await platformAdministratorProofCurrent(env.client, saved!, principalId, actor)).toBe(false);
  }
});

test('draft reads refuse an administrator resource grant without platform use or current control', async () => {
  const env = harness();
  env.state.grant = zoneEditScope(zone);
  env.state.administrator = false;
  expect(await zonePageContentAllowed(env.client, env.graph, principalId, actor, zone, false)).toBe(
    false,
  );
  env.state.administrator = true;
  env.state.control = false;
  expect(await zonePageContentAllowed(env.client, env.graph, principalId, actor, zone, false)).toBe(
    false,
  );
});

test('a saved steward proof cannot switch to an administrator after stewardship is revoked', async () => {
  const env = harness();
  env.state.editor = true;
  const request = env.request('content.draft', zone);
  const proof = await newBaselineProof(env.client, env.graph, request, principalId);
  env.state.editor = false;
  env.state.grant = zoneEditScope(zone);
  expect(
    await baselineProofCurrent(env.client, env.graph, proof!, {
      principal_id: principalId,
      acting_subject: actor,
      scope_id: request.scope,
      action: request.action,
    }),
  ).toBe(false);
});

test('a Zone page marker refuses malformed page scopes and mixed Work authority', () => {
  const env = harness();
  for (const extra of [
    { scope: `work:edit:${page}` },
    { scope: 'content:draft:bad' },
    { baselineRelatedWork: page },
    { baselineCollectionCreate: true },
  ]) {
    expect(resolveZonePageContent(env.request('content.draft', zone, extra))).toEqual({
      kind: 'refused',
    });
  }
});

test('Work targets do not consult zone.edit', async () => {
  const env = harness();
  env.state.author = true;
  env.state.editor = true;
  for (const action of ['content.draft', 'content.publish'] as const) {
    env.sparql.length = 0;
    const proof = await newBaselineProof(env.client, env.graph, env.request(action), principalId);
    expect(proof).toMatchObject({
      author_work: page,
      author_generation: '7',
      realm_membership: null,
    });
    expect(env.sparql.some((query) => query.includes('space:create:root'))).toBe(false);
  }
  env.sparql.length = 0;
  env.state.author = false;
  expect(
    await newBaselineProof(env.client, env.graph, env.request('work.edit', zone), principalId),
  ).toBeNull();
  expect(env.sparql.some((query) => query.includes('space:create:root'))).toBe(false);
  env.sql.length = 0;
  expect(
    await newBaselineProof(
      env.client,
      env.graph,
      env.request('content.draft', zone, {
        baselineRelatedWork: page,
      }),
      principalId,
    ),
  ).toBeNull();
  expect(env.sql).toEqual([]);
});
