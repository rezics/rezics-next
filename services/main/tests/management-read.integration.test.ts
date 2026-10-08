import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { createMainApp } from '../src/app.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { ManagementReadStore, realmGovernanceScope } from '../src/modules/management-reads/read-store.ts';
import { MODERATION_CONTEXT_COST } from '../src/modules/management-reads/read-contract.ts';
import { ModResolutionStore } from '../src/modules/package/mod-resolution.ts';
import { DATASET, GRAPHS, RV, iri } from '../src/modules/work/activate.ts';
import { fusekiReadBudget } from '../src/infrastructure/fuseki.ts';

const short = (id: string) => id.slice(-36);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Notifying content decisions store the statement a person can appeal. */
function notifyingReasons(facts: string, scope: string, ruleDigest: string) {
  return {
    facts, scope, duration: 'Until an attributable decision supersedes this one.',
    automation: false, appealRoute: '/v1/public-reports/{caseId}/correspondence',
    contentLanguage: 'en', rule: { ref: 'urn:rezics:rule:test', revision: 'r1', digest: ruleDigest },
  };
}
interface Page<T> { items: T[]; nextCursor: string | null; count: { value: number; total: null; kind: string } }

test('Realm management: private report queue, decision audit, pagination, scope and stale fences', async () => {
  const stack = await startMediaStack('management-read');
  try {
    const a = await stack.member('moderator');
    const b = await stack.member('outsider');
    await a.grant('space:create:root', 'space.create');
    const made = await a.send('POST', '/v1/spaces', { profile: 'space-realm-v1', name: 'Management Realm',
      capabilities: ['realm'], actingSubject: a.actor });
    expect(made.status).toBe(201);
    const realm = (await made.json() as { realm: string }).realm;
    const scope = realmGovernanceScope(realm);
    await a.grant(scope, 'governance.moderate');
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      managementReads: new ManagementReadStore(stack.accessPool, stack.env),
      account: { verify: async request => {
        const token = request.headers.get('authorization')?.replace('Bearer ', '');
        if (token === a.token) return a.principal;
        if (token === b.token) return b.principal;
        throw new AccountAssertionDenied('missing bearer');
      } } });
    const get = (path: string, token?: string) => app.handle(new Request(`http://main.test${path}`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} }));
    const root = `/v1/realms/${short(realm)}`;
    const moderation = (suffix = '', token = a.token, actor = a.actor) =>
      get(`${root}/moderation?actingSubject=${encodeURIComponent(actor)}${suffix}`, token);
    const audit = (suffix = '', token = a.token, actor = a.actor) =>
      get(`${root}/audit?actingSubject=${encodeURIComponent(actor)}${suffix}`, token);
    const cases = [];
    for (let n = 0; n < 3; n++) {
      const caseId = randomUUID();
      const target = `https://rezics.com/id/${randomUUID()}`;
      await stack.accessPool.query(`INSERT INTO access.governance_case (id, kind, authority_kind,
        authority_scope_id, context, target_owner, target_resource, target_component, disclosure)
        VALUES ($1, 'content_report', 'realm', $2, $3, 'graph', $4, 'title', 'private')`,
      [caseId, scope, realm, target]);
      await stack.accessPool.query(`INSERT INTO access.governance_report (id, case_id, principal_id,
        acting_subject, principal_epoch, idempotency_key, request_digest, reason_code,
        evidence_count, evidence_digest) VALUES ($1, $2, $3, $4, 0, $5, $6, 'incorrect', 1, $7)`,
      [randomUUID(), caseId, a.principalId, a.actor, `report-${n}`, digest(`request-${n}`), digest(`evidence-${n}`)]);
      cases.push({ caseId, target });
    }
    const otherRealm = `https://rezics.com/id/${randomUUID()}`;
    const otherScope = realmGovernanceScope(otherRealm);
    await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [otherScope]);
    await expect(stack.accessPool.query(`INSERT INTO access.governance_case (id, kind, authority_kind,
      authority_scope_id, context, target_owner, target_resource, target_component, disclosure)
      VALUES ($1, 'content_report', 'realm', $2, $3, 'graph', $4, 'title', 'private')`,
    [randomUUID(), scope, otherRealm, `https://rezics.com/id/${randomUUID()}`])).rejects.toMatchObject({ code: '23514' });
    expect((await get(`${root}/moderation?actingSubject=${encodeURIComponent(a.actor)}`)).status).toBe(401);
    expect((await moderation('', b.token, b.actor)).status).toBe(404);
    expect((await get(`/v1/realms/${randomUUID()}/moderation?actingSubject=${encodeURIComponent(a.actor)}`,
      a.token)).status).toBe(404);
    const first = await moderation('&limit=1');
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    const page = await first.json() as Page<{ id: string; target: { resource: string };
      authorAgent: string; reasonCode: string }>;
    expect(page.count).toEqual({ value: 1, kind: 'exact-page', total: null });
    expect(page.nextCursor).toBeString();
    expect(cases.some(item => item.caseId === page.items[0]?.id)).toBe(true);
    expect(page.items[0]).toMatchObject({ authorAgent: a.actor, reasonCode: 'incorrect' });
    await stack.accessPool.query(`INSERT INTO access.governance_case (id, kind, authority_kind,
      authority_scope_id, context, target_owner, target_resource, target_component, disclosure)
      VALUES ($1, 'content_report', 'realm', $2, $3, 'graph', $4, 'title', 'private')`,
    [randomUUID(), otherScope, otherRealm, `https://rezics.com/id/${randomUUID()}`]);
    expect((await moderation('&type=rights_complaint').then(r => r.json()) as Page<unknown>).items).toEqual([]);
    expect((await moderation('&type=content_report').then(r => r.json()) as Page<unknown>).items)
      .toHaveLength(3);
    // G-395: a reason narrows the queue to cases a report gave it for; submissions have none.
    expect((await moderation('&reason=incorrect').then(r => r.json()) as Page<unknown>).items).toHaveLength(3);
    expect((await moderation('&reason=spam').then(r => r.json()) as Page<unknown>).items).toEqual([]);
    expect((await moderation('&reason=Not%20a%20code')).status).toBe(400);
    const graphQuery = stack.fuseki.query.bind(stack.fuseki);
    let concurrentWrite = false;
    stack.fuseki.query = async (...args) => {
      const result = await graphQuery(...args);
      if (!concurrentWrite && args[0].includes('SELECT ?epoch ?sequence ?realm')) {
        concurrentWrite = true;
        await fusekiReadBudget.exit(() => stack.privateWork(a.actor, 'Unrelated write during management read'));
      }
      return result;
    };
    try { expect((await moderation()).status).toBe(200); }
    finally { stack.fuseki.query = graphQuery; }
    expect(concurrentWrite).toBe(true);
    // Continuations bind the Realm queue revision, not the unrelated graph head.
    const second = await moderation(`&limit=1&cursor=${page.nextCursor}`);
    expect(second.status).toBe(200);
    const next = await second.json() as Page<{ id: string }>;
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
    expect((await moderation(`&state=closed&cursor=${page.nextCursor}`)).status).toBe(400);
    expect((await moderation('&cursor=broken')).status).toBe(400);
    expect((await moderation('&limit=21')).status).toBe(400);
    const decisionId = randomUUID();
    await stack.accessPool.query(`INSERT INTO access.moderation_decision (id, kind, outcome,
      context, case_id, case_sequence, principal_id, acting_subject, authority_kind,
      authority_scope_id, authority_epoch, authority_proof_digest, idempotency_key,
      request_digest, rule_ref, rule_revision, rule_digest, evidence_digest, disclosure, rationale,
      statement_of_reasons)
      VALUES ($1, 'content_moderation', 'dismiss', $2, $3, 1, $4, $5, 'realm', $6, 0,
        $7, 'decision-1', $8, 'urn:rezics:rule:test', 'r1', $9, $10, 'private', 'The edition is named', $11)`,
    [decisionId, realm, cases[0]!.caseId, a.principalId, a.actor, scope,
      digest('proof'), digest('decision'), digest('rule'), digest('evidence'),
      notifyingReasons('The recorded title names the edition.', 'This Work title', digest('rule'))]);
    await stack.accessPool.query(`UPDATE access.governance_case SET decision_head = $2,
      generation = 1 WHERE id = $1`, [cases[0]!.caseId, decisionId]);
    const log = await audit();
    expect(log.status).toBe(200);
    // G-395: the log names what each decision was about and why, so Manage can show the Work.
    expect((await log.json() as Page<{ id: string; actingSubject: string }>).items)
      .toMatchObject([{ id: decisionId, actingSubject: a.actor, reason: 'The edition is named',
        target: { owner: 'graph', resource: cases[0]!.target, component: 'title' } }]);
    expect((await audit('&kind=rights_disposition').then(r => r.json()) as Page<unknown>).items).toEqual([]);
    expect((await moderation(`&limit=1&cursor=${page.nextCursor}`)).status).toBe(409);
    await stack.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} <${RV}restoreHold> true . } }`);
    expect((await moderation()).status).toBe(503);
    await stack.fuseki.update(`DELETE DATA { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} <${RV}restoreHold> true . } }`);
    expect((await moderation()).status).toBe(200);
    await stack.fuseki.update(`DELETE DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} a <${RV}Realm> . } }`);
    expect((await moderation()).status).toBe(404);
    await stack.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} a <${RV}Realm> . } }`);
    const query = stack.fuseki.query.bind(stack.fuseki);
    let resumeRead!: () => void;
    let readReached!: () => void;
    const paused = new Promise<void>(resolve => { readReached = resolve; });
    const resumed = new Promise<void>(resolve => { resumeRead = resolve; });
    let basisCalls = 0;
    stack.fuseki.query = async (...args) => {
      if (args[0].includes('SELECT ?epoch ?sequence ?realm') && ++basisCalls === 2) {
        readReached();
        await resumed;
      }
      return query(...args);
    };
    const inFlight = moderation();
    await paused;
    const revoke = stack.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE scope_id = $1 AND recipient_subject = $2`, [scope, a.actor]);
    resumeRead();
    expect((await inFlight).status).toBe(200);
    await revoke;
    stack.fuseki.query = query;
    expect((await moderation()).status).toBe(404);
    expect((await audit()).status).toBe(404);
  } finally { await stack.stop(); }
});

test('G-395 moderation context: submitter and reporter records, readable Works only, consent and statement budget', async () => {
  const stack = await startMediaStack('management-context');
  try {
    const owner = await stack.member('owner');
    const moderator = await stack.member('moderator');
    const reviewer = await stack.member('reviewer');
    const outsider = await stack.member('outsider');
    const submitter = await stack.member('submitter');
    const reporter = await stack.member('reporter');
    await owner.grant('space:create:root', 'space.create');
    const made = await owner.send('POST', '/v1/spaces', { profile: 'space-realm-v1', name: 'Context Realm',
      capabilities: ['realm'], actingSubject: owner.actor });
    expect(made.status).toBe(201);
    const realm = (await made.json() as { realm: string }).realm;
    const scope = realmGovernanceScope(realm);
    await moderator.grant(scope, 'governance.moderate');
    await reviewer.grant(`review:decide:${realm}`, 'review.decide');

    // The reporter filed three reports here: one upheld, one kept, one still open.
    const outcomes = ['restrict', 'dismiss', null] as const;
    for (const [n, outcome] of outcomes.entries()) {
      const caseId = randomUUID();
      await stack.accessPool.query(`INSERT INTO access.governance_case (id, kind, authority_kind,
        authority_scope_id, context, target_owner, target_resource, target_component, disclosure)
        VALUES ($1, 'content_report', 'realm', $2, $3, 'graph', $4, 'title', 'private')`,
      [caseId, scope, realm, `https://rezics.com/id/${randomUUID()}`]);
      await stack.accessPool.query(`INSERT INTO access.governance_report (id, case_id, principal_id,
        acting_subject, principal_epoch, idempotency_key, request_digest, reason_code,
        evidence_count, evidence_digest) VALUES ($1, $2, $3, $4, 0, $5, $6, 'spoiler.in_title', 1, $7)`,
      [randomUUID(), caseId, reporter.principalId, reporter.actor, `context-report-${n}`, digest(`context-${n}`),
        digest(`context-evidence-${n}`)]);
      if (!outcome) continue;
      const decision = randomUUID();
      await stack.accessPool.query(`INSERT INTO access.moderation_decision (id, kind, outcome, context, case_id,
        case_sequence, principal_id, acting_subject, authority_kind, authority_scope_id, authority_epoch,
        authority_proof_digest, idempotency_key, request_digest, rule_ref, rule_revision, rule_digest,
        evidence_digest, disclosure, statement_of_reasons) VALUES ($1, 'content_moderation', $2, $3, $4, 1, $5, $6, 'realm', $7, 0,
        $8, $9, $10, 'urn:rezics:rule:test', 'r1', $11, $12, 'private', $13)`,
      [decision, outcome, realm, caseId, moderator.principalId, moderator.actor, scope, digest('proof'),
        `context-decision-${n}`, digest(`decision-${n}`), digest('rule'), digest('evidence'),
        notifyingReasons(outcome === 'restrict'
          ? 'The title discloses the ending before the reader chooses it.'
          : 'The report does not show a title that needs restriction.',
        'This Work title', digest('rule'))]);
      await stack.accessPool.query('UPDATE access.governance_case SET decision_head = $2, generation = 1 WHERE id = $1',
        [caseId, decision]);
    }
    // The submitter offered three texts: one waits, one was accepted, one rejected; and is banned for a week.
    for (const state of ['pending', 'accepted', 'rejected'] as const) {
      await stack.accessPool.query(`INSERT INTO access.realm_submission (id, realm, kind, work, main_version,
        contribution, publication_decision, selected_draft, submitting_agent, state, revision, public_reason,
        selection, adoption_receipt) VALUES ($1, $2, 'contribution', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [randomUUID(), realm, `https://rezics.com/id/${randomUUID()}`, `https://rezics.com/id/${randomUUID()}`,
        `https://rezics.com/id/${randomUUID()}`, `https://rezics.com/id/${randomUUID()}`,
        `https://rezics.com/id/${randomUUID()}`, submitter.actor, state, randomUUID(),
        state === 'rejected' ? 'Name the translation' : null,
        state === 'accepted' ? `https://rezics.com/id/${randomUUID()}` : null,
        state === 'accepted' ? `https://rezics.com/id/${randomUUID()}` : null]);
    }
    // Realm management bootstrap would write the Realm's membership policy; bans reference it.
    await stack.accessPool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'institution')
      ON CONFLICT DO NOTHING`, [realm]);
    await stack.accessPool.query(`INSERT INTO access.membership_policy (kind, owner_subject, revision, terms_revision)
      VALUES ('realm', $1, 0, 'realm-membership-v1') ON CONFLICT DO NOTHING`, [realm]);
    await stack.accessPool.query(`INSERT INTO access.membership_ban (kind, owner_subject, member_subject, active,
      reason_ref, expires_at) VALUES ('realm', $1, $2, true, 'context-ban', now() + interval '7 days')`,
    [realm, submitter.actor]);

    const readable = await stack.publicWork(owner.actor);
    const hidden = await stack.privateWork(owner.actor);
    const chapter = await stack.privateWork(owner.actor);
    // The public Book places the private chapter in its contents, as Studio's chapter command does.
    const [structure, generation, placement, occurrence] = Array.from({ length: 4 },
      () => `https://rezics.com/id/${randomUUID()}`);
    await stack.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(structure)} a <${RV}Structure> ; <${RV}structureProfile> <${RV}BookComposition> ;
        <${RV}structureOf> ${iri(readable.mainVersion)} ; <${RV}selectedGeneration> ${iri(generation)} .
      ${iri(placement)} a <${RV}OccurrencePlacement> ; <${RV}generation> ${iri(generation)} ;
        <${RV}occurrenceRole> <${RV}ChapterRole> ; <https://schema.org/item> ${iri(chapter.work)} ;
        <${RV}occurrence> ${iri(occurrence)} . } }`);
    await stack.accessPool.query(`INSERT INTO access.mod_work_binding (work, resolution_id, principal_id, card)
      VALUES ($1, $2, $3, $4)`, [readable.work, randomUUID(), owner.principalId, JSON.stringify({
      profile: 'mod-work-card-v1', game: 'Minecraft', gameVersions: ['1.21.1'], loaders: ['Fabric'],
      latestRelease: '2.0.0', capturedAt: '2026-09-28T00:00:00.000Z' })]);

    const measurements = { sql: 0 };
    const pool = new Proxy(stack.accessPool, { get(target, property) {
      if (property === 'connect') return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, member) {
          if (member === 'query') return (...args: unknown[]) => {
            measurements.sql++;
            return Reflect.apply(connection.query, connection, args);
          };
          const value = Reflect.get(connection, member);
          return typeof value === 'function' ? value.bind(connection) : value;
        } });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    // Each token carries the scopes its Account consented to; Access grants never widen them.
    const consent = new Map<string, { principal: typeof owner.principal; scopes: string[] }>([
      [moderator.token, { principal: moderator.principal, scopes: ['governance:decide', 'work:read'] }],
      [reviewer.token, { principal: reviewer.principal, scopes: ['realm:adopt', 'work:read'] }],
      [outsider.token, { principal: outsider.principal, scopes: ['governance:decide', 'realm:adopt', 'work:read'] }],
    ]);
    const narrow = randomUUID();
    consent.set(narrow, { principal: moderator.principal, scopes: ['realm:adopt', 'work:read'] });
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access, content: stack.content,
      managementReads: new ManagementReadStore(pool as never, stack.env),
      packageModResolutions: new ModResolutionStore(stack.contentPool, stack.accessPool),
      account: { verify: async (request, scopes) => {
        const held = consent.get(request.headers.get('authorization')?.replace('Bearer ', '') ?? '');
        if (!held || !(scopes ?? []).every(scope => held.scopes.includes(scope))) {
          throw new AccountAssertionDenied('scope not consented');
        }
        return held.principal;
      } } });
    const context = (actor: string, token: string | null, query: Record<string, string>) => app.handle(new Request(
      `http://main.test/v1/realms/${short(realm)}/moderation/context?${new URLSearchParams({ actingSubject: actor, ...query })}`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} }));
    const agents = [reporter.actor, submitter.actor, outsider.actor].join(',');
    interface Context { people: { agent: string; membership: { state: string; joinedAt: string | null; banned: boolean;
      bannedUntil: string | null };
      submissions: Record<string, unknown> | null; reports: Record<string, unknown> | null }[];
    works: { work: string; partOf: unknown; authors: unknown[]; mod: unknown; hub: unknown }[] }

    expect((await context(moderator.actor, null, { agents })).status).toBe(401);
    expect((await context(outsider.actor, outsider.token, { agents })).status).toBe(404);
    // A moderator whose token lacks the moderation consent reads nothing, whatever Access grants.
    expect((await context(moderator.actor, narrow, { agents })).status).toBe(404);
    expect((await context(moderator.actor, moderator.token, { agents: 'not-an-id' })).status).toBe(400);
    expect((await context(moderator.actor, moderator.token, { agents: `${reporter.actor},${reporter.actor}` })).status)
      .toBe(400);
    expect((await context(moderator.actor, moderator.token, { agents: Array.from({ length: 21 },
      () => `https://rezics.com/id/${randomUUID()}`).join(',') })).status).toBe(400);

    // A moderator meets reporters: their accuracy here. Submitters and strangers stay out.
    measurements.sql = 0;
    const moderated = await context(moderator.actor, moderator.token, { agents });
    expect(moderated.status).toBe(200);
    expect(moderated.headers.get('cache-control')).toBe('private, no-store');
    expect(measurements.sql).toBeLessThanOrEqual(MODERATION_CONTEXT_COST.sqlStatements);
    const seen = await moderated.json() as Context;
    expect(seen.people).toEqual([{ agent: reporter.actor,
      membership: { state: 'not_joined', joinedAt: null, banned: false, bannedUntil: null }, submissions: null,
      reports: { open: 1, upheld: 1, dismissed: 1, total: 3, capped: false } }]);

    // A reviewer meets submitters: what became of their offers, and whether they are banned.
    measurements.sql = 0;
    const reviewed = await context(reviewer.actor, reviewer.token, { agents });
    expect(measurements.sql).toBeLessThanOrEqual(MODERATION_CONTEXT_COST.sqlStatements);
    const offered = (await reviewed.json() as Context).people;
    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({ agent: submitter.actor, reports: null,
      membership: { banned: true, bannedUntil: expect.any(String) },
      submissions: { open: 1, accepted: 1, rejected: 1, changesRequested: 0, withdrawn: 0, total: 3, capped: false } });

    // A Book placement never discloses another independently maintained Work.
    const before = stack.fuseki.queries;
    const works = await context(moderator.actor, moderator.token,
      { works: `${readable.work},${hidden.work},${chapter.work}` });
    expect(works.status).toBe(200);
    expect(stack.fuseki.queries - before).toBeLessThanOrEqual(MODERATION_CONTEXT_COST.graphCalls);
    expect((await works.json() as Context).works).toEqual([{ work: readable.work, partOf: null, authors: [], hub: null,
      mod: { game: 'Minecraft', gameVersions: ['1.21.1'], loaders: ['Fabric'], latestRelease: '2.0.0' } }]);

    await stack.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE scope_id = $1 AND recipient_subject = $2`, [scope, moderator.actor]);
    expect((await context(moderator.actor, moderator.token, { agents })).status).toBe(404);
  } finally { await stack.stop(); }
}, 120_000);
