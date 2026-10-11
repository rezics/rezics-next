import { afterAll, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { ContentCore, SaveDraftCommand } from '../../content/src/core.ts';
import { AccountAssertionInsufficientScope } from '../src/modules/account/verify-assertion.ts';
import type { VerifiedAccountAssertion } from '../src/modules/account/verify-assertion.ts';
import { AdmissionDenied } from '../src/modules/access/admission.ts';
import type { AccessAdmissionRegistry, VerifiedPrincipal, RegisteredAdmission } from '../src/modules/access/admission.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { CanonicalReplyParentReader } from '../src/modules/realm-reply/root.ts';
import type { TargetReadSession } from '../src/modules/target/resolve.ts';
import type { ResolvedTarget } from '../src/modules/target/contract.ts';

const targetModule = { ...(await import('../src/modules/target/resolve.ts')) };
interface ReadState {
  currentTargetRevision: string;
  retained: Set<string>;
  erased: Set<string>;
}
let readState: ReadState = { currentTargetRevision: '', retained: new Set(), erased: new Set() };
type DraftAccess = Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>
  & Partial<Pick<AccessAdmissionRegistry, 'fenceClaim' | 'withRealmPolicy' | 'canReadWork' | 'canReadSemanticResource'>>;
type TestAccess = DraftAccess & {
  registrations: Array<{ requestDigest: string; scope: string; idempotencyKey: string }>;
  readonly claims: number;
};
type TestAdmissionRequest = { requestDigest: string; scope: string; idempotencyKey: string;
  principal?: VerifiedPrincipal; actingSubject?: string; action?: string };

function targetSession(authority: { access?: unknown; principal?: VerifiedPrincipal; actingSubject?: string }): TargetReadSession {
  const query = async (sparql: string) => {
    if (sparql.includes('SELECT ?context WHERE')) return [];
    const retained = sparql.match(/BIND\(<([^>]+)> AS \?root\)/)?.[1];
    if (retained) return readState.retained.has(retained) && !readState.erased.has(retained)
      ? [{ root: { value: retained } }] : [];
    return [];
  };
  return { query, checkDeadline: () => {}, request: new Request('http://main.local/v1/resources'),
    options: { actingSubject: authority.actingSubject }, position: { dataEpoch: '1', sequence: '1' },
    displayLanguages: ['en'], principal: authority.principal ?? null,
    deps: { environment: {} as WorkActivationEnvironment, access: authority.access as never } } as unknown as TargetReadSession;
}

await mock.module('../src/modules/target/resolve.ts', () => ({
  ...targetModule,
  targetRead: async <T>(_environment: WorkActivationEnvironment,
    authority: { access?: unknown; principal?: VerifiedPrincipal; actingSubject?: string },
    operation: (session: TargetReadSession) => Promise<T>) => operation(targetSession(authority)),
  resolveTargets: async (_session: TargetReadSession, resources: readonly string[]) => resources.map(resource => ({
    resource, base: 'work', revision: readState.currentTargetRevision, work: resource,
    types: [], disclosure: 'restricted',
  } as ResolvedTarget)),
}));

afterAll(async () => { await mock.module('../src/modules/target/resolve.ts', () => targetModule); });

const { ContentConflict } = await import('../../content/src/core.ts');
const { saveMemberReplyDraft, saveVerifiedMemberReplyDraft, verifyMemberReplyDraftPrincipal } =
  await import('../src/modules/content-publication/reply-draft.ts');
const { WorkReadMissing, WorkReadMoved } = await import('../src/modules/work/read-session.ts');

const id = () => `https://rezics.com/id/${randomUUID()}`;
const principal: VerifiedAccountAssertion = { issuer: 'https://account.example', subject: 'person-subject' };
const position = { dataEpoch: '00000000-0000-4000-8000-000000000001', sequence: '7' };

function fixture(access = accessOwner()): {
  env: WorkActivationEnvironment;
  content: ContentCore;
  access: ReturnType<typeof accessOwner>;
  commands: SaveDraftCommand[];
  saveCalls: number;
} {
  const commands: SaveDraftCommand[] = [];
  let saveCalls = 0;
  let saved: SaveDraftCommand | null = null;
  const env = { lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() },
    fuseki: { query: async (sparql: string) => sparql.includes('SELECT ?space ?realmRevision')
      ? { results: { bindings: [{ space: { value: id() },
        disclosure: { value: 'https://rezics.com/vocab/Public' },
        visibility: { value: 'public' }, mode: { value: 'open' } }] } }
      : { boolean: true, results: { bindings: [] } } } } as unknown as WorkActivationEnvironment;
  const content = {
    readExactBatch: async () => [],
    readDraftReceipt: async (operationId: string) => saved?.operationId === operationId ? { operationId } : null,
    saveDraft: async (command: SaveDraftCommand) => {
      saveCalls++;
      const prior = saved?.operationId === command.operationId;
      if (!prior) { saved = command; commands.push(command); }
      return { outcome: 'succeeded' as const, revisionId: '11111111-1111-4111-8111-111111111111',
        predecessor: command.expectedHead, position, replayed: prior };
    },
  } as unknown as ContentCore;
  return { env, content, access, commands,
    get saveCalls() { return saveCalls; } };
}

function accessOwner(refuse: (request: TestAdmissionRequest) => boolean = () => false): TestAccess {
  const registrations: Array<{ requestDigest: string; scope: string; idempotencyKey: string }> = [];
  let claims = 0;
  return {
    registrations,
    get claims() { return claims; },
    register: async (request: TestAdmissionRequest) => {
      if (refuse(request)) throw new AdmissionDenied('reply author is not eligible');
      const existing = registrations.find(item => item.idempotencyKey === request.idempotencyKey);
      if (existing && existing.requestDigest !== request.requestDigest) throw new ContentConflict('request changed');
      if (!existing) registrations.push(request);
      return { id: '22222222-2222-4222-8222-222222222222', authorityEpoch: '5', scope: request.scope,
        state: existing ? 'sealed' : 'registered', replayed: !!existing,
        dispatchEligible: !existing } as RegisteredAdmission;
    },
    claim: async () => { claims++; },
    fenceClaim: async () => { claims++; },
    recordGraphOutcome: async () => {},
    withRealmPolicy: async (_principal: VerifiedPrincipal, _actor: string, _realm: string, _action: string,
      dispatch: (permit: { member: boolean }, client: object) => Promise<unknown>) => dispatch({ member: true }, {}),
  } as unknown as TestAccess;
}

function rootState(rootRevision: string, currentTargetRevision = rootRevision) {
  readState = { currentTargetRevision, retained: new Set([rootRevision]), erased: new Set() };
}

function ordinaryInput(rootTarget: string, rootRevision: string) {
  return { reply: id(), variantId: `urn:rezics:variant:${randomUUID()}`, rootTarget, rootRevision,
    expectedHead: null, language: 'en', direction: 'ltr' as const, body: 'A concise reply',
    actingSubject: id(), spoiler: false };
}

function canonicalInput(realm: string, about: string, targetRevision: string) {
  return { reply: id(), variantId: `urn:rezics:variant:${randomUUID()}`, realm, about, targetRevision,
    originRealm: realm, expectedHead: null, language: 'en', direction: 'ltr' as const,
    body: 'A reply to the retained thread', actingSubject: id(), spoiler: false };
}

function parentReader(record: { realm: string; about: string; reply: string; rootRevision: string; originRealm: string } | null,
  revisionId: string | null): CanonicalReplyParentReader {
  return { opener: async () => record,
    visibleParent: async () => revisionId ? { revisionId } : null };
}

test('the Request adapter and verified-principal entrypoint save the same public draft intent', async () => {
  const target = id(), rootRevision = id(), key = 'same-draft-intent';
  rootState(rootRevision);
  const input = ordinaryInput(target, rootRevision);
  const direct = fixture();
  const directResult = await saveVerifiedMemberReplyDraft(direct.env, direct.content, direct.access,
    principal, { kind: 'member-reply', input }, key);
  const adapter = fixture();
  const request = new Request('http://main.local/v1/member-reply-drafts');
  let verifiedRequest: Request | undefined;
  const adaptedResult = await saveMemberReplyDraft(adapter.env, adapter.content,
    { verify: async (actual, scopes) => { verifiedRequest = actual; expect(scopes).toEqual(['comment:create']); return principal; } },
    adapter.access, request, input, key);
  expect(verifiedRequest).toBe(request);
  expect(adaptedResult).toEqual(directResult);
  expect(adapter.commands[0]?.serializedJson).toBe(direct.commands[0]?.serializedJson);
  expect(adapter.access.registrations[0]).toEqual(direct.access.registrations[0]);
  expect(adapter.saveCalls).toBe(1);
});

test('the shared principal verifier refuses a token without comment:create before draft effects', async () => {
  const target = id(), rootRevision = id();
  rootState(rootRevision);
  const fx = fixture();
  const request = new Request('http://main.local/v1/realms/realm/about-posts', {
    headers: { authorization: 'Bearer token-without-comment-create' },
  });
  const grantedScopes = new Set(['work:read']);
  const account = { verify: async (actual: Request, scopes: readonly string[]) => {
    expect(actual).toBe(request);
    expect(actual.headers.get('authorization')).toBe('Bearer token-without-comment-create');
    if (scopes.some(scope => !grantedScopes.has(scope))) {
      throw new AccountAssertionInsufficientScope('Account assertion lacks a required scope');
    }
    return principal;
  } };
  const intent = async () => {
    const verified = await verifyMemberReplyDraftPrincipal(account, request);
    return saveVerifiedMemberReplyDraft(fx.env, fx.content, fx.access, verified,
      { kind: 'member-reply', input: ordinaryInput(target, rootRevision) }, 'missing-comment-scope');
  };
  await expect(intent()).rejects.toBeInstanceOf(AccountAssertionInsufficientScope);
  expect(fx.access.registrations).toHaveLength(0);
  expect(fx.saveCalls).toBe(0);
});

test('a canonical child draft uses the opener retained root after the about resource changes', async () => {
  const realm = id(), about = id(), opener = id(), oldRoot = id(), currentTarget = id();
  const parentRevision = randomUUID();
  rootState(oldRoot, currentTarget);
  const fx = fixture();
  const input = canonicalInput(realm, about, currentTarget);
  const result = await saveVerifiedMemberReplyDraft(fx.env, fx.content, fx.access, principal,
    { kind: 'canonical-about-reply', input, parentReader: parentReader({ realm, about,
      reply: opener, rootRevision: oldRoot, originRealm: realm }, parentRevision) }, 'canonical-child');
  expect(result).toMatchObject({ rootTarget: about, rootRevision: oldRoot, originRealm: realm,
    canonicalParent: { realm, about, reply: opener, parentRevision, rootRevision: oldRoot, originRealm: realm } });
  const saved = JSON.parse(fx.commands[0]!.serializedJson) as Record<string, unknown>;
  expect(saved.rootRevision).toBe(oldRoot);
  expect(saved.canonicalParent).toMatchObject({ reply: opener, parentRevision, rootRevision: oldRoot });
  expect(fx.saveCalls).toBe(1);
});

test.skip('a steward cannot draft canonically as a controlled Org (pending Trust-ops Access Person-author change)', async () => {
  const realm = id(), about = id(), targetRevision = id(), organization = id();
  rootState(targetRevision);
  const steward = principal;
  const controlledOrganizations = new Map([[organization, steward.subject]]);
  const fx = fixture(accessOwner(request => request.action === 'content.draft'
    && controlledOrganizations.get(request.actingSubject ?? '') === request.principal?.subject));
  const input = canonicalInput(realm, about, targetRevision);
  input.actingSubject = organization;
  await expect(saveVerifiedMemberReplyDraft(fx.env, fx.content, fx.access, steward,
    { kind: 'canonical-about-reply', input, parentReader: parentReader(null, null) }, 'org-steward-reply'))
    .rejects.toBeInstanceOf(AdmissionDenied);
  expect(fx.saveCalls).toBe(0);
  expect(fx.access.registrations).toHaveLength(0);
});

test('caller-supplied parent, approval, or retained-root fields are rejected', async () => {
  const realm = id(), about = id(), rootRevision = id();
  rootState(rootRevision);
  for (const key of ['parentReply', 'parentRevision', 'opener', 'approval', 'approvalId',
    'retainedRoot', 'retainedRootRevision', 'rootTarget', 'rootRevision']) {
    const fx = fixture();
    const input = Object.assign(canonicalInput(realm, about, rootRevision), { [key]: id() });
    await expect(saveVerifiedMemberReplyDraft(fx.env, fx.content, fx.access, principal,
      { kind: 'canonical-about-reply', input, parentReader: parentReader(null, null) }, `forged-${key}`))
      .rejects.toBeInstanceOf(ContentConflict);
    expect(fx.saveCalls).toBe(0);
    expect(fx.access.registrations).toHaveLength(0);
  }
});

test('a changed live target is stale and creates no draft', async () => {
  const realm = id(), about = id(), observed = id(), current = id(), opener = id();
  rootState(id(), current);
  const fx = fixture();
  await expect(saveVerifiedMemberReplyDraft(fx.env, fx.content, fx.access, principal,
    { kind: 'canonical-about-reply', input: canonicalInput(realm, about, observed),
      parentReader: parentReader({ realm, about, reply: opener, rootRevision: id(), originRealm: realm }, randomUUID()) },
    'changed-target')).rejects.toBeInstanceOf(WorkReadMoved);
  expect(fx.saveCalls).toBe(0);
  expect(fx.access.registrations).toHaveLength(0);
});

test('an opener from a changed origin Realm is hidden and creates no draft', async () => {
  const realm = id(), otherRealm = id(), about = id(), rootRevision = id();
  rootState(rootRevision);
  const fx = fixture();
  await expect(saveVerifiedMemberReplyDraft(fx.env, fx.content, fx.access, principal,
    { kind: 'canonical-about-reply', input: canonicalInput(realm, about, rootRevision),
      parentReader: parentReader({ realm, about, reply: id(), rootRevision, originRealm: otherRealm }, randomUUID()) },
    'changed-origin')).rejects.toBeInstanceOf(WorkReadMissing);
  expect(fx.saveCalls).toBe(0);
  expect(fx.access.registrations).toHaveLength(0);
});

test('an erased opener root is hidden and creates no draft', async () => {
  const realm = id(), about = id(), opener = id(), oldRoot = id(), current = id();
  rootState(oldRoot, current);
  readState.erased.add(oldRoot);
  const fx = fixture();
  await expect(saveVerifiedMemberReplyDraft(fx.env, fx.content, fx.access, principal,
    { kind: 'canonical-about-reply', input: canonicalInput(realm, about, current),
      parentReader: parentReader({ realm, about, reply: opener, rootRevision: oldRoot, originRealm: realm }, randomUUID()) },
    'erased-root')).rejects.toBeInstanceOf(WorkReadMissing);
  expect(fx.saveCalls).toBe(0);
  expect(fx.access.registrations).toHaveLength(0);
});

test('a hidden canonical parent is a 404-equivalent refusal with no draft', async () => {
  const realm = id(), about = id(), opener = id(), oldRoot = id(), current = id();
  rootState(oldRoot, current);
  const fx = fixture();
  await expect(saveVerifiedMemberReplyDraft(fx.env, fx.content, fx.access, principal,
    { kind: 'canonical-about-reply', input: canonicalInput(realm, about, current),
      parentReader: parentReader({ realm, about, reply: opener, rootRevision: oldRoot, originRealm: realm }, null) },
    'hidden-parent')).rejects.toBeInstanceOf(WorkReadMissing);
  expect(fx.saveCalls).toBe(0);
  expect(fx.access.registrations).toHaveLength(0);
});

test('a lost canonical draft response replays the exact revision and bytes once', async () => {
  const realm = id(), about = id(), opener = id(), oldRoot = id(), current = id();
  const parentRevision = randomUUID();
  rootState(oldRoot, current);
  const fx = fixture();
  const input = canonicalInput(realm, about, current);
  const intent = { kind: 'canonical-about-reply' as const, input,
    parentReader: parentReader({ realm, about, reply: opener, rootRevision: oldRoot, originRealm: realm }, parentRevision) };
  const first = await saveVerifiedMemberReplyDraft(fx.env, fx.content, fx.access, principal, intent, 'lost-response');
  const replay = await saveVerifiedMemberReplyDraft(fx.env, fx.content, fx.access, principal, intent, 'lost-response');
  expect(replay.replayed).toBe(true);
  expect(replay.revisionId).toBe(first.revisionId);
  expect(replay.revisionDigest).toBe(first.revisionDigest);
  expect(replay.sourcePosition).toEqual(first.sourcePosition);
  expect(fx.commands).toHaveLength(1);
  expect(fx.saveCalls).toBe(2);
  expect(fx.access.registrations).toHaveLength(1);
});
