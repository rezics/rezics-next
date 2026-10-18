import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import declaration from '../../../../../scripts/qa/cases/outcomes/realm/identity-discovery.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import type { PersonaName } from '../../../support/personas.ts';
import { identityReaderFixture, reached, short, type IdentityReaderFixture,
  type IdentityChoice, type SessionChoice } from '../../../support/identity-reader-fixture.ts';

setDefaultTimeout(60_000);
let fixture: IdentityReaderFixture;
beforeAll(async () => { fixture = await identityReaderFixture(); }, 600_000);
afterAll(async () => { await fixture?.close(); });
const paths = ['/v1/me/agents', '/v1/me/session-agent', '/v1/me/main-agent-preference'] as const;
type Client = Awaited<ReturnType<IdentityReaderFixture['login']>>;
type Discovery = { profile: string; complete: boolean; items: { actingSubject: string;
  kind: string | null; handle: string | null; displayName: { value: string; language: string; direction: string } | null }[] };
type Write = { profile: string; actingSubject: string | null; revision: string; replayed: boolean };
async function answer<T>(id: string, label: string, pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, raw = await response.text();
  reached(id, `${label}: HTTP ${status}`);
  expect(response.status, `${label}: ${response.status} ${raw}`).toBe(status);
  if (status === 200) expect(response.headers.get('cache-control')).toContain('no-store');
  return JSON.parse(raw) as T;
}
function callback(client: Client) {
  expect(client.callbacks).toHaveLength(1);
  const actual = new URL(client.callbacks[0]!), registered = new URL(client.redirectUri);
  expect(actual.origin + actual.pathname).toBe(registered.origin + registered.pathname);
  expect(actual.searchParams.get('state')).toBe(client.state);
  expect(JSON.parse(actual.searchParams.get('state')!).next).toBe(client.next);
}
async function accountUnchanged(id: string, client: Client) {
  const response = await client.person.account('GET', '/api/auth/get-session');
  const raw = await response.text();
  reached(id, 'Account session retains the same signed-in user');
  expect(response.status, raw).toBe(200);
  expect(JSON.parse(raw)).toMatchObject({ user: { id: client.person.accountId } });
}
const nextFor = (name: PersonaName) => `/en/library?view=reading&from=${name}&next=%2Fen%2Fstudio`;

// Assertion mode leaves declarations pending while observing genuine failures.
// A setup error cannot satisfy test.failing; baseline passes remain passes.
outcomeTest(declaration, 'visitor', async () => {
  const id = 'D4-007/visitor';
  for (const path of paths) {
    const headers = new Headers();
    if (path.endsWith('/session-agent')) headers.set('x-session-key', randomUUID());
    const denied = await answer<{ code: string }>(id, path, fetch(new URL(path, fixture.mainOrigin), { headers }), 401);
    expect(denied.code).toBe('account_assertion_denied');
  }
  const work = `/v1/works/${short(fixture.corpus.publicBook.work)}`;
  await answer(id, 'public reader after identity sign-in refusal', fixture.sessions.visitor.main('GET', work));
  const signedIn = await fixture.login('empty', nextFor('visitor'));
  callback(signedIn);
  await accountUnchanged(id, signedIn);
  expect(await answer(id, 'visitor sign-in returns to the requested reader without provisioning an Agent',
    signedIn.request('GET', paths[0]))).toEqual({ profile: 'agent-discovery-v1', complete: true, items: [] });
}, undefined, { pending: 'assert' });

async function represented(name: Exclude<PersonaName, 'visitor'>) {
    const id = `D4-007/${name}`, client = await fixture.login(name, nextFor(name));
    callback(client);
    const actor = client.person.actingSubject!, alternative = fixture.corpus.alternatives[name];
    const discovery = await answer<Discovery>(id, 'eligible Agent inventory', client.request('GET', paths[0]));
    expect(discovery).toMatchObject({ profile: 'agent-discovery-v1', complete: true });
    expect(discovery.items.map(item => item.actingSubject).sort()).toEqual([actor, alternative].sort());
    expect(discovery.items.find(item => item.actingSubject === actor)).toMatchObject({ kind: 'person',
      displayName: { value: `Outcome ${name}` } });
    expect(discovery.items.find(item => item.actingSubject === alternative)).toMatchObject({ kind: 'organization',
      displayName: { value: `Original ${name} garden group` } });
    const emptyChoice: IdentityChoice = { actingSubject: null, revision: null, eligible: false };
    const initial = await answer<SessionChoice>(id, 'unselected session with multiple eligible Agents', client.request('GET', paths[1]));
    expect(initial).toEqual({ profile: 'session-agent-v1', sessionAgent: emptyChoice, mainAgent: emptyChoice, initialActingSubject: null });
    const chosen = await answer<Write>(id, 'explicit Session Agent', client.request('PUT', paths[1], {
      actingSubject: actor, expectedRevision: null,
    }, randomUUID()));
    expect(chosen).toMatchObject({ profile: 'session-agent-v1', actingSubject: actor, replayed: false });
    const preferred = await answer<Write>(id, 'independent Main Agent preference', client.request('PUT', paths[2], {
      actingSubject: alternative, expectedRevision: null,
    }, randomUUID()));
    const selected = await answer<SessionChoice>(id, 'read both explicit choices', client.request('GET', paths[1]));
    expect(selected).toEqual({ profile: 'session-agent-v1',
      sessionAgent: { actingSubject: actor, revision: chosen.revision, eligible: true },
      mainAgent: { actingSubject: alternative, revision: preferred.revision, eligible: true }, initialActingSubject: null });
    const ineligible = fixture.corpus.realm.identities[name === 'owner' ? 'stranger' : 'owner'].actingSubject;
    const denied = await answer<{ code: string }>(id, 'unrepresented Agent choice', client.request('PUT', paths[1], {
      actingSubject: ineligible, expectedRevision: chosen.revision,
    }, randomUUID()), 403);
    expect(denied.code).toBe('acting_context_denied');
    const stale = await answer<{ code: string }>(id, 'stale choice revision', client.request('PUT', paths[1], {
      actingSubject: alternative, expectedRevision: null,
    }, randomUUID()), 409);
    expect(stale.code).toBe('stale_context');
    expect(await answer(id, 'denied/stale preserve both choices', client.request('GET', paths[1]))).toEqual(selected);
    const cleared = await answer<Write>(id, 'explicit unselection', client.request('PUT', paths[1], {
      actingSubject: null, expectedRevision: chosen.revision,
    }, randomUUID()));
    expect(await answer(id, 'unselection does not fall back to Main Agent', client.request('GET', paths[1]))).toEqual({
      ...selected, sessionAgent: { actingSubject: null, revision: cleared.revision, eligible: false },
    });
    const restored = await answer<Write>(id, 'restore explicit Session Agent', client.request('PUT', paths[1], {
      actingSubject: actor, expectedRevision: cleared.revision,
    }, randomUUID()));
    const expected = { ...selected, sessionAgent: { actingSubject: actor, revision: restored.revision, eligible: true } };
    const beforeFailures = fixture.fault.failures;
    fixture.fault.fail(true);
    try {
      for (const path of paths) {
        const unavailable = await answer<{ code: string }>(id, `transient owner failure ${path}`, client.request('GET', path), 503);
        expect(unavailable.code).toBe('acting_context_unavailable');
      }
      expect(fixture.fault.failures).toBeGreaterThan(beforeFailures);
      await accountUnchanged(id, client);
    } finally { fixture.fault.fail(false); }
    expect(await answer(id, 'recovery preserves exact choices and revisions', client.request('GET', paths[1]))).toEqual(expected);
    expect((await answer<Discovery>(id, 'bounded explicit retry recovers discovery', client.request('GET', paths[0]))).items)
      .toEqual(discovery.items);
    await accountUnchanged(id, client);
    const returned = await fixture.login(name, client.next);
    callback(returned);
    expect(returned.person.accountId).toBe(client.person.accountId);
    const returningSession = await answer<SessionChoice>(id, 'new session uses eligible Main Agent only as initial suggestion',
      returned.request('GET', paths[1]));
    expect(returningSession).toEqual({ profile: 'session-agent-v1', sessionAgent: emptyChoice,
      mainAgent: expected.mainAgent, initialActingSubject: alternative });
}

outcomeTest(declaration, 'stranger', () => represented('stranger'), undefined, { pending: 'assert' });
outcomeTest(declaration, 'member', () => represented('member'), undefined, { pending: 'assert' });
outcomeTest(declaration, 'owner', () => represented('owner'), undefined, { pending: 'assert' });
outcomeTest(declaration, 'moderator', () => represented('moderator'), undefined, { pending: 'assert' });
outcomeTest(declaration, 'operator', () => represented('operator'), undefined, { pending: 'assert' });

test('D4-007 / authenticated empty Account: 200 empty is distinct from sign-out, denial and owner failure', async () => {
  const id = 'D4-007/authenticated-empty', client = await fixture.login('empty', '/en/studio?tab=works');
  callback(client);
  expect(await answer(id, 'real signed-in empty inventory', client.request('GET', paths[0]))).toEqual({
    profile: 'agent-discovery-v1', complete: true, items: [],
  });
  const choice = { actingSubject: null, eligible: false, revision: null };
  expect(await answer(id, 'real signed-in unselected session', client.request('GET', paths[1]))).toEqual({
    profile: 'session-agent-v1', sessionAgent: choice, mainAgent: choice, initialActingSubject: null,
  });
  expect(await answer(id, 'real signed-in empty preference', client.request('GET', paths[2]))).toEqual({
    profile: 'main-agent-preference-v1', mainAgent: choice,
  });
  const denied = await answer<{ code: string }>(id, 'empty inventory cannot select another Person', client.request('PUT', paths[1], {
    actingSubject: fixture.corpus.realm.identities.owner.actingSubject, expectedRevision: null,
  }, randomUUID()), 403);
  expect(denied.code).toBe('acting_context_denied');
  await accountUnchanged(id, client);
  await answer(id, 'signed-in Account without Agent can still read public Book', client.request('GET',
    `/v1/works/${short(fixture.corpus.publicBook.work)}`));
});

test('D4-007 / insufficient scope and invalid bearer: never replace authenticated refusal with anonymous discovery', async () => {
  const id = 'D4-007/denied', client = await fixture.login('stranger', nextFor('stranger'), 'openid profile email work:read');
  for (const path of paths) {
    const denied = await answer<{ code: string }>(id, `insufficient scope ${path}`, client.request('GET', path), 403);
    expect(denied.code).toBe('insufficient_scope');
  }
  await accountUnchanged(id, client);
  const invalid = await answer<{ code: string }>(id, 'invalid bearer', fetch(new URL(paths[0], fixture.mainOrigin), {
    headers: { authorization: 'Bearer invalid' },
  }), 401);
  expect(invalid.code).toBe('account_assertion_denied');
});
