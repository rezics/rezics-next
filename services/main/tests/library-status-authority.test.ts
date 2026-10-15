import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AccountAssertionDenied, AccountAssertionInsufficientScope, AccountAssertionUnavailable }
  from '../src/modules/account/verify-assertion.ts';
import { AdmissionUnavailable } from '../src/modules/access/admission.ts';
import type { StatusCommand } from '../src/modules/library/status.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { libraryRoutes } from '../src/routes/library.ts';
import { typedRefusal } from '../src/routes/problems.ts';

const id = (number: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const work = id(1), main = id(2), revision = id(3), person = id(4), foreignPerson = id(5);
const term = (value: string, type = 'literal', language?: string) =>
  ({ type, value, ...(language ? { 'xml:lang': language } : {}) });
const result = (rows: Record<string, ReturnType<typeof term>>[]): SparqlResult => ({ results: { bindings: rows } });

/** Only the selected Work is modeled here; the outcome owns the real inventory. */
class LibraryWorkGraph extends FusekiClient {
  constructor() { super('http://graph.invalid/rezics'); }
  override async commandHealth() {
    return { profiles: { 'work-metadata-v1': 'a'.repeat(64) } } as never;
  }
  override async query(query: string): Promise<SparqlResult> {
    const control = { epoch: term('epoch'), sequence: term('1') };
    if (query.includes('SELECT ?epoch ?sequence ?hold ?r')) return result([{ ...control,
      r: term(work, 'uri'), type: term('work'), work: term(work, 'uri'), head: term(revision, 'uri'),
      public: term('true'), label: term('Original animation', 'literal', 'en') }]);
    if (query.includes('SELECT ?epoch ?sequence ?r ?revision ?type ?mergedInto')) return result([{ ...control,
      r: term(work, 'uri'), revision: term(revision, 'uri'), type: term('https://schema.org/CreativeWork', 'uri') }]);
    if (query.includes('SELECT ?head ?main ?mainHead')) return result([{
      head: term(revision, 'uri'), main: term(main, 'uri'), mainHead: term(id(6), 'uri'), public: term('true') }]);
    if (query.includes('SELECT ?structuredDecision ?structuredSource')
      || query.includes('SELECT ?selection ?language') || query.includes('SELECT ?work ?head')) return result([]);
    if (query.includes('SELECT ?epoch ?sequence')) return result([control]);
    throw new Error(`Unexpected library Work query: ${query}`);
  }
}

function fixture() {
  const state = { active: true, scopes: ['work:read', 'library:write'], accountAvailable: true, accessAvailable: true,
    recoveryOpen: true, refuseSecondExchange: false };
  const required: string[][] = [], writes: StatusCommand[] = [];
  const deps = {
    environment: { fuseki: new LibraryWorkGraph(), lineage: { dataEpoch: 'epoch', routingEpoch: '1' } },
    account: { verify: async (_request: Request, scopes: readonly string[]) => {
      required.push([...scopes]);
      if (!state.accountAvailable) throw new AccountAssertionUnavailable('Account enforcement is unavailable');
      if (state.refuseSecondExchange && required.length === 2) throw new AccountAssertionUnavailable('Account enforcement is unavailable');
      if (!state.active) throw new AccountAssertionDenied('Account assertion is inactive');
      if (scopes.some(scope => !state.scopes.includes(scope))) throw new AccountAssertionInsufficientScope('Missing consent');
      return { issuer: 'https://account.test', subject: 'moderator', emailVerified: true, accountScopes: state.scopes };
    } },
    access: {
      canReadAsBaselineMember: async (principal: { subject: string }, actor: string) => {
        if (!state.accessAvailable) throw new AdmissionUnavailable('Access admission store could not be reached');
        return principal.subject === 'moderator' && actor === person;
      },
      activePrincipalId: async () => 'moderator',
      assertRecoveryOpen: async () => {
        if (!state.recoveryOpen) throw new AdmissionUnavailable('Access is held for recovery');
      },
    },
    libraryStatus: { write: async (command: StatusCommand) => {
      writes.push(command);
      return { work: command.work, status: command.status, startedOn: null, finishedOn: null,
        version: 1, changedAt: '2026-10-14T00:00:00.000Z', replayed: false };
    } },
  } as unknown as MainWorkDependencies;
  const app = new Elysia().onError(({ error }) => typedRefusal(error)).use(libraryRoutes(deps));
  const write = (actor = person) => app.handle(new Request(`http://main.local/v1/works/${work.slice(-36)}/reader-status`, {
    method: 'PUT', headers: { authorization: 'Bearer moderator', 'content-type': 'application/json',
      'idempotency-key': 'start-watching' },
    body: JSON.stringify({ actingSubject: actor, expectedVersion: 0, status: 'reading' }),
  }));
  return { state, required, writes, write };
}

test('reader-status uses its current writer admission for the Work read without a second Account exchange', async () => {
  const f = fixture();
  f.state.refuseSecondExchange = true;
  const response = await f.write();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ work, status: 'reading', version: 1 });
  expect(f.required).toEqual([['work:read', 'library:write']]);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]).toMatchObject({ agent: person, work, expectedVersion: 0,
    principal: { subject: 'moderator' } });
});

test('reader-status still refuses unavailable Account, Access and recovery before writing', async () => {
  for (const unavailable of ['accountAvailable', 'accessAvailable', 'recoveryOpen'] as const) {
    const f = fixture();
    f.state[unavailable] = false;
    const response = await f.write();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'dependency_unavailable',
      title: 'A required authority service is unavailable' });
    expect(f.writes).toEqual([]);
  }
});

test('joined moderation never supplies foreign Person control to a reader-status command', async () => {
  const f = fixture();
  const response = await f.write(foreignPerson);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'reader_library_denied' });
  expect(f.writes).toEqual([]);
});

test('a later reader-status request checks current revocation and writer consent again', async () => {
  for (const refusal of ['active', 'scopes'] as const) {
    const f = fixture();
    expect((await f.write()).status).toBe(200);
    if (refusal === 'active') f.state.active = false;
    else f.state.scopes = ['work:read'];
    expect((await f.write()).status).toBe(401);
    expect(f.required).toEqual([['work:read', 'library:write'], ['work:read', 'library:write']]);
    expect(f.writes).toHaveLength(1);
  }
});
