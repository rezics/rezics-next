import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import type { Pool } from 'pg';
import { RealmJoinRequests, joinRequestQuery, ownJoinRequestPage } from '../src/modules/realm-admin/join-requests.ts';
import { JOIN_REQUEST_READ_COST, JOIN_REQUEST_SEARCH_SQL, decodeRequestCursor, encodeRequestCursor,
  requestCursorBinding, requestSearch } from '../src/modules/realm-admin/join-requests-read.ts';
import { RealmAdminDenied, RealmAdminInvalid, RealmAdminStale, RealmAdminUnavailable } from '../src/modules/realm-admin/contract.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { realmAdminRoutes } from '../src/routes/realm-admin.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const realm = `https://rezics.com/id/${uuid(1)}`, actor = `https://rezics.com/id/${uuid(2)}`;
const principal = { issuer: 'https://account.test',subject: 'requester' };
const row = (n: number) => ({ id: uuid(n),member: actor,membership_generation: '0',policy_revision: '3',
  terms_revision: 'terms-v3',reason: 'Join',created_at: new Date('2026-10-02T00:00:00Z') });

function fixture() {
  const queries: { sql: string; values: unknown[] }[] = [];
  const state = { gate: true, recovery: true, actor: true, manager: true, owned: true, generation: '3',inboxGeneration: '3',ownGeneration: '3',
    representationGeneration: '0', rows: [row(3),row(4)],
    decisions: [{ ...row(3),state: 'pending',decided_at: null as Date | null }] };
  const client = { release() {},async query(sql: string,values: unknown[] = []) {
    queries.push({ sql,values });
    let rows: unknown[] = [];
    if (sql.includes('access.recovery_fence')) rows = state.recovery ? [{}] : [];
    else if (sql.includes('FROM access.scope_gate')) rows = state.gate ? [{}] : [];
    else if (sql.includes('FROM access.principal p JOIN access.representation')) rows = state.actor ? [{ id: uuid(10),epoch: '0',
      representation: uuid(11),representationGeneration: state.representationGeneration,subjectGeneration: '0',
      validUntil: new Date('2030-01-01') }] : [];
    else if (sql.includes('FROM access.permission_grant')) rows = state.manager ? [{ id: uuid(12),generation: '0',valid_until: new Date('2030-01-01') }] : [];
    else if (sql.includes('FROM access.realm_admin_revision')) rows = [{ generation: state.generation }];
    else if (sql.includes('FROM access.realm_join_request_inbox_revision')) rows = [{ generation: state.inboxGeneration }];
    else if (sql.includes('FROM access.realm_join_request_member_revision')) rows = [{ generation: state.ownGeneration }];
    else if (sql === JOIN_REQUEST_SEARCH_SQL) rows = state.rows.map(({ id }) => ({ id }));
    else if (sql.includes('SELECT 1 FROM access.realm_join_request q')) rows = state.owned ? [{}] : [];
    else if (sql.includes('COALESCE(d.kind')) rows = state.decisions;
    else if (sql.includes('FROM access.realm_join_request_pending p')) rows = state.rows;
    return { rows,rowCount: rows.length };
  } };
  const pool = { connect: async () => client } as unknown as Pool;
  return { owner: new RealmJoinRequests(pool,{} as WorkActivationEnvironment),state,queries };
}

test('G-953: inbox searches before hydration, binds continuation and reports exhaustion honestly', async () => {
  const f = fixture();
  const options = { actingSubject: actor,q: '@Ａｌｉｃｅ',limit: 1 };
  const first = await f.owner.list(principal,realm,options);
  expect(first.items.map(item => item.id)).toEqual([uuid(3)]);
  expect(first.complete).toBe(false);
  const search = f.queries.find(query => query.sql === JOIN_REQUEST_SEARCH_SQL)!;
  expect(search.values).toEqual([realm,null,'Alice',2,'Alice']);
  const hydrated = f.queries.find(query => query.sql.includes('q.reason'))!;
  expect(hydrated.values).toEqual([realm,null,2,[uuid(3),uuid(4)]]);
  expect(f.queries.indexOf(search)).toBeLessThan(f.queries.indexOf(hydrated));
  f.state.rows = [row(4)];
  const second = await f.owner.list(principal,realm,{ ...options,cursor: first.nextCursor! });
  expect(second).toMatchObject({ items: [{ id: uuid(4) }],nextCursor: null,complete: true });
  expect(f.queries.filter(query => query.sql === JOIN_REQUEST_SEARCH_SQL).at(-1)!.values[1]).toBe(uuid(3));
  await expect(f.owner.list(principal,realm,{ ...options,q: 'Bob',cursor: first.nextCursor! })).rejects.toBeInstanceOf(RealmAdminStale);
  f.state.generation = '4';
  await expect(f.owner.list(principal,realm,{ ...options,cursor: first.nextCursor! })).rejects.toBeInstanceOf(RealmAdminStale);
  f.state.generation = '3'; f.state.inboxGeneration = '4';
  await expect(f.owner.list(principal,realm,{ ...options,cursor: first.nextCursor! })).rejects.toBeInstanceOf(RealmAdminStale);
  f.state.inboxGeneration = '3'; f.state.representationGeneration = '1';
  await expect(f.owner.list(principal,realm,{ ...options,cursor: first.nextCursor! })).rejects.toBeInstanceOf(RealmAdminStale);
});

test('G-953: both reads require current authority, fail closed during recovery and reject invalid bounds', async () => {
  for (const kind of ['actor','manager'] as const) {
    const f = fixture(); f.state[kind] = false;
    await expect(f.owner.list(principal,realm,{ actingSubject: actor })).rejects.toBeInstanceOf(RealmAdminDenied);
    expect(f.queries.some(query => query.sql.includes('q.reason'))).toBe(false);
  }
  const f = fixture(); f.state.actor = false;
  await expect(f.owner.own(principal,realm,{ actingSubject: actor })).rejects.toBeInstanceOf(RealmAdminDenied);
  f.state.actor = true; f.state.recovery = false;
  await expect(f.owner.own(principal,realm,{ actingSubject: actor })).rejects.toBeInstanceOf(RealmAdminUnavailable);
  await expect(f.owner.list(principal,realm,{ actingSubject: actor })).rejects.toBeInstanceOf(RealmAdminUnavailable);
  expect(Value.Check(joinRequestQuery,{ actingSubject: actor,limit: 51 })).toBe(false);
  expect(Value.Check(joinRequestQuery,{ actingSubject: actor,q: 'a'.repeat(81) })).toBe(false);
  expect(() => f.owner.list(principal,realm,{ actingSubject: actor,after: uuid(3),cursor: 'a' })).toThrow(RealmAdminInvalid);
});

test('G-953: own history includes each terminal time and uses both actor and private requester binding', async () => {
  const f = fixture();
  for (const state of ['pending','accepted','declined','withdrawn']) {
    const time = state === 'pending' ? null : new Date('2026-10-02T01:00:00Z');
    f.state.decisions = [{ ...row(3),state,decided_at: time }];
    const page = await f.owner.own(principal,realm,{ actingSubject: actor });
    expect(Value.Check(ownJoinRequestPage,page)).toBe(true);
    expect(page.items[0]).toMatchObject({ state,decidedAt: time?.toISOString() ?? null,
      requestGeneration: state === 'pending' ? '0' : '1' });
    const read = f.queries.filter(query => query.sql.includes('COALESCE(d.kind')).at(-1)!;
    expect(read.values).toEqual([realm,actor,uuid(10),null,51]);
    expect(read.sql).toContain('b.principal_id = $3');
    expect(read.sql).toContain('q.member = $2');
    expect(page).toMatchObject({ complete: true,nextCursor: null });
  }
  f.state.decisions = [3,4,5].map(n => ({ ...row(n),state: 'pending',decided_at: null }));
  const first = await f.owner.own(principal,realm,{ actingSubject: actor,limit: 2 });
  expect(first.items).toHaveLength(2);
  expect(first.complete).toBe(false);
  f.state.decisions = [{ ...row(5),state: 'withdrawn',decided_at: new Date() }];
  expect((await f.owner.own(principal,realm,{ actingSubject: actor,cursor: first.nextCursor! })).complete).toBe(true);
  expect(f.queries.filter(query => query.sql.includes('COALESCE(d.kind')).at(-1)!.values[3]).toBe(uuid(4));
  f.state.inboxGeneration = '4';
  expect((await f.owner.own(principal,realm,{ actingSubject: actor,cursor: first.nextCursor! })).complete).toBe(true);
  f.state.ownGeneration = '4';
  await expect(f.owner.own(principal,realm,{ actingSubject: actor,cursor: first.nextCursor! })).rejects.toBeInstanceOf(RealmAdminStale);
});

test('G-953: missing Realm and no own request give identical no-store 404 responses; scopes stay purpose-specific', async () => {
  const f = fixture(), scopes: string[][] = [];
  const work = { realmJoinRequests: f.owner,account: { verify: async (_request: Request,required: string[]) => {
    scopes.push(required); return principal;
  } } } as unknown as MainWorkDependencies;
  const app = realmAdminRoutes(work);
  const call = () => app.handle(new Request(`http://main.test/v1/realms/${uuid(1)}/join-requests/mine?actingSubject=${actor}`));
  f.state.gate = false;
  const missing = await call();
  expect(missing.status).toBe(404);
  expect(missing.headers.get('cache-control')).toBe('no-store');
  const missingBody = await missing.json();
  f.state.gate = true; f.state.owned = false;
  const noRequest = await call();
  expect(noRequest.status).toBe(404);
  expect(await noRequest.json()).toEqual(missingBody);
  expect(noRequest.headers.get('cache-control')).toBe('no-store');
  f.state.owned = true;
  const own = await call();
  expect(own.status).toBe(200);
  expect(own.headers.get('cache-control')).toBe('private, no-store');
  expect(scopes.at(-1)).toEqual(['access:membership-consent']);
  const inbox = await app.handle(new Request(`http://main.test/v1/realms/${uuid(1)}/join-requests?actingSubject=${actor}&q=Alice&limit=1`));
  expect(inbox.status).toBe(200);
  expect(scopes.at(-1)).toEqual(['governance:decide']);
});

test('G-953: literal Unicode search and opaque cursors cannot silently change selection', () => {
  expect(requestSearch('  @Ａｌｉｃｅ  ')).toBe('Alice');
  expect(requestSearch('王_%\\')).toBe('王_%\\');
  expect(() => requestSearch('bad\u0000')).toThrow(RealmAdminInvalid);
  const binding = requestCursorBinding(['own',realm,actor]);
  expect(decodeRequestCursor(encodeRequestCursor(uuid(3),binding),binding)).toBe(uuid(3));
  for (const cursor of ['!',Buffer.from('{}').toString('base64url'),'a'.repeat(513)]) {
    expect(() => decodeRequestCursor(cursor,binding)).toThrow(RealmAdminInvalid);
  }
  expect(JOIN_REQUEST_SEARCH_SQL.match(/LIMIT \$4/g)).toHaveLength(JOIN_REQUEST_READ_COST.searchBranches + 1);
  expect(JOIN_REQUEST_SEARCH_SQL).toContain('FROM access.name_registry h');
  expect(JOIN_REQUEST_SEARCH_SQL).toContain("h.scope = 'agent'");
  expect(JOIN_REQUEST_SEARCH_SQL).toContain("h.state = 'current'");
  expect(JOIN_REQUEST_SEARCH_SQL).toContain('pending.member = h.holder');
  expect(JOIN_REQUEST_SEARCH_SQL).toContain('access.realm_member_search_key(h.key)');
  expect(JOIN_REQUEST_SEARCH_SQL).not.toContain('access.agent_handle');
  expect(JOIN_REQUEST_SEARCH_SQL).not.toContain('account_subject');
});
