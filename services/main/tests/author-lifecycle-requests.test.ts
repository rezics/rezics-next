import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { ContentCore, ExactContentReference, SaveDraftCommand } from '../../content/src/core.ts';
import { ContentConflict } from '../../content/src/core.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { memberReplyRoutes } from '../src/routes/member-replies.ts';
import { realmReplyRoutes } from '../src/routes/realm-replies.ts';
import { commandError } from '../src/routes/problems.ts';
import { AdmissionDenied, type RegisteredAdmission } from '../src/modules/access/admission.ts';
import { ContentEligibilityConflict, ContentEligibilityStale } from '../src/modules/content-publication/eligibility.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { GRAPHS, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { ReadRow } from '../src/modules/work/read-session.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const bind = (value: string) => ({ type: /^(https:|urn:)/.test(value) ? 'uri' : 'literal', value });

/** Real request/target/disclosure adapters with bounded graph and owner doubles. */
function fixture() {
  const actor = id(), root = id(), rootRevision = id(), reply = id(), realm = id();
  const epoch = randomUUID(), revisionId = randomUUID(), variantId = `urn:rezics:variant:${randomUUID()}`;
  const principal = { issuer: 'https://account.test', subject: randomUUID(), emailVerified: true };
  const calls = { registered: 0, claims: 0, saved: [] as SaveDraftCommand[], visible: [] as string[][],
    counts: [] as string[][], exact: 0, targets: 0 };
  const reference: ExactContentReference = { owner: 'content', resourceId: reply, variantId, revisionId,
    format: 'rezics-content-json-v1', model: 'member-reply-v1', byteDigest: 'a'.repeat(64), byteLength: 32,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', sourceRevision: rootRevision,
    predecessor: null, provenance: { kind: 'admitted-original-contribution-v1', author: actor } };
  const state = { author: actor, available: true, live: true, visible: true };
  const saved = { outcome: 'succeeded' as const, revisionId: randomUUID(), predecessor: revisionId,
    position: { dataEpoch: epoch, sequence: '31' }, replayed: false };
  let admission: RegisteredAdmission;
  const content = {
    readExactBatch: async () => {
      calls.exact++;
      return state.available ? [{ revisionId, status: 'available',
        reference: { ...reference, provenance: { ...reference.provenance, author: state.author } },
        body: { body: 'Original reply', rootTarget: root, rootRevision, spoiler: true } }] : [];
    },
    readDraftReceipt: async () => null,
    saveDraft: async (command: SaveDraftCommand) => { calls.saved.push(command); return saved; },
    cancelDraft: async () => saved,
  } as unknown as ContentCore;
  const access = {
    assertRecoveryOpen: async () => {}, canReadWork: async () => true,
    activePrincipalId: async () => principal.subject,
    register: async (request: { scope: string; requestDigest: string }) => {
      calls.registered++;
      if (!state.live) throw new AdmissionDenied('Person control revoked');
      admission = { ...request, id: randomUUID(), authorityEpoch: '2', action: 'content.draft',
        state: 'registered', dispatchEligible: true, replayed: false } as RegisteredAdmission;
      return admission;
    },
    claim: async () => { calls.claims++; if (!state.live) throw new AdmissionDenied('Person control revoked'); },
    recordGraphOutcome: async () => {},
  };
  const environment = { objectDirectory: '.temp/author-lifecycle-requests',
    lineage: { dataEpoch: epoch, routingEpoch: '1' }, fuseki: { query: async (sql: string) => {
      let rows: ReadRow[];
      if (sql.includes('ASK')) return { boolean: true };
      if (sql.includes('AS ?hasCurrentIdentity')) {
        calls.targets++;
        rows = [{ epoch: bind(epoch), sequence: bind('30'), r: bind(root), hasCurrentIdentity: bind('true'),
          type: bind('work'), work: bind(root), head: bind(rootRevision), public: bind('true'),
          erased: bind('false'), label: { ...bind('Root Work'), 'xml:lang': 'en' } }];
      } else if (sql.includes('SELECT ?epoch ?sequence ?r ?revision')) {
        rows = [{ epoch: bind(epoch), sequence: bind('30'), r: bind(root), revision: bind(rootRevision),
          type: bind('https://schema.org/CreativeWork') }];
      } else if (sql.includes('SELECT ?root WHERE')) rows = [{ root: bind(rootRevision) }];
      else if (sql.includes('SELECT ?resource ?head')) rows = [{ resource: bind(root), head: bind(rootRevision) }];
      else if (sql.includes('SELECT ?work ?head ?owningWork ?owningHead')) rows = [{ work: bind(root), head: bind(rootRevision) }];
      else if (sql.includes('rv:RestoreCutover')) rows = [];
      else if (sql.includes(`GRAPH <${GRAPHS.control}>`)) rows = [{ epoch: bind(epoch), sequence: bind('30') }];
      else throw new Error(`Unexpected author request graph query: ${sql}`);
      return { results: { bindings: rows } };
    } } } as unknown as WorkActivationEnvironment;
  configureFixtureDisclosureAncestry(environment, target => target.work
    ? { resource: target.work, head: rootRevision, protectedRevision: target.workRevision } : undefined);
  configureDisclosure(environment, fixtureDisclosureReader(async targets => targets.map(() => 'visible')));
  const placement = { placement: id(), realm, reply, revisionId, reviewDecisionId: randomUUID(),
    rootTarget: root, author: actor };
  const deps = { environment, account: { verify: async () => principal }, access, contentAuthoring: content,
    realmReplies: {
      visible: async (selectedRealm: string, selectedReply: string) => {
        calls.visible.push([selectedRealm, selectedReply]); return state.visible ? placement : null;
      },
      rootCount: async (selectedRealm: string, selectedRoot: string) => {
        calls.counts.push([selectedRealm, selectedRoot]); return { realm, rootTarget: root, count: 1, complete: true };
      },
    } } as unknown as MainWorkDependencies;
  const draft = { profile: 'member-reply-draft-v1', reply, variantId, rootTarget: root, rootRevision,
    originRealm: null, language: 'en', direction: 'ltr', expectedHead: revisionId,
    body: 'Corrected reply', actingSubject: actor };
  const post = (body: object) => memberReplyRoutes(deps).handle(new Request('http://localhost/v1/member-reply-drafts', {
    method: 'POST', headers: { authorization: 'Bearer person', 'content-type': 'application/json',
      'idempotency-key': randomUUID() }, body: JSON.stringify(body),
  }));
  const get = (path: string) => realmReplyRoutes(deps).handle(new Request(`http://localhost${path}?actingSubject=${actor}`, {
    headers: { authorization: 'Bearer person' },
  }));
  return { actor, root, rootRevision, reply, realm, calls, state, reference, placement, draft, post, get };
}

for (const persona of ['stranger', 'member', 'moderator', 'operator']) {
  test(`reply correction refuses the ${persona} as a foreign author before admission or Content CAS`, async () => {
    const f = fixture();
    for (const spoiler of [undefined, false, true]) {
      const response = await f.post({ ...f.draft, actingSubject: id(), ...(spoiler === undefined ? {} : { spoiler }) });
      expect(response.status, await response.clone().text()).toBe(403);
      expect((await response.json()).code).toBe('authority_denied');
    }
    expect(f.calls.exact).toBe(3);
    expect(f.calls.registered).toBe(0);
    expect(f.calls.claims).toBe(0);
    expect(f.calls.saved).toHaveLength(0);
  });
}

test('the author correction preserves an omitted spoiler and still uses current admission and Content CAS', async () => {
  const f = fixture();
  const response = await f.post(f.draft);
  expect(response.status, await response.clone().text()).toBe(201);
  expect(f.calls.exact).toBe(1);
  expect(f.calls.registered).toBe(1);
  expect(f.calls.claims).toBe(2);
  expect(f.calls.saved).toHaveLength(1);
  expect(JSON.parse(f.calls.saved[0]!.serializedJson).spoiler).toBe(true);
  expect(f.calls.saved[0]!.provenance.author).toBe(f.actor);
  expect(f.calls.saved[0]!.expectedHead).toBe(f.draft.expectedHead);
});

test('author preflight cannot replace live control and never infers authority from missing or mismatched history', async () => {
  const revoked = fixture();
  revoked.state.live = false;
  expect((await revoked.post(revoked.draft)).status).toBe(403);
  expect(revoked.calls.saved).toHaveLength(0);
  for (const mismatch of ['missing', 'resource', 'variant', 'model', 'provenance']) {
    const f = fixture();
    if (mismatch === 'missing') f.state.available = false;
    if (mismatch === 'resource') f.reference.resourceId = id();
    if (mismatch === 'variant') f.reference.variantId = `urn:rezics:variant:${randomUUID()}`;
    if (mismatch === 'model') f.reference.model = 'content-shape-v1';
    if (mismatch === 'provenance') f.reference.provenance.kind = 'unbound';
    expect((await f.post(f.draft)).status).toBe(409);
    expect(f.calls.registered).toBe(0);
    expect(f.calls.saved).toHaveLength(0);
  }
});

test('the HTTP problem adapter preserves stale qualification versus changed-intent and draft conflicts', async () => {
  const stale = commandError(new ContentEligibilityStale('exact head moved'));
  expect(stale.status).toBe(409);
  expect((await stale.json()).code).toBe('stale_eligibility_head');
  for (const error of [new ContentEligibilityConflict('changed intent'), new ContentConflict('draft CAS changed')]) {
    const response = commandError(error);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('content_conflict');
  }
});

for (const pathForm of ['uuid', 'encoded-native']) {
  test(`placement reads accept ${pathForm} segments and retain exact native owner and root fences`, async () => {
    const f = fixture(), segment = (value: string) => pathForm === 'uuid' ? value.slice(-36) : encodeURIComponent(value);
    const response = await f.get(`/v1/realms/${segment(f.realm)}/replies/${segment(f.reply)}`);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ profile: 'realm-reply-placement-v1', ...f.placement });
    expect(f.calls.visible).toEqual([[f.realm, f.reply]]);
    expect(f.calls.targets).toBeGreaterThan(0);
    f.state.visible = false;
    const hidden = await f.get(`/v1/realms/${segment(f.realm)}/replies/${segment(f.reply)}`);
    expect(hidden.status).toBe(404);
    expect((await hidden.text())).not.toContain(f.placement.author);
    const count = await f.get(`/v1/realms/${segment(f.realm)}/reply-roots/${segment(f.root)}/count`);
    expect(count.status, await count.clone().text()).toBe(200);
    expect(f.calls.counts).toEqual([[f.realm, f.root]]);
  });
}
