import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { RowOutcomes } from '../../../../../scripts/qa/cases/outcome-cells.ts';
import { personaNames, type PersonaName, type PersonaSession,
  type PersonaSessions } from '../../../support/personas.ts';

type RequestEvidence = {
  caller: string | null; actingSubject: string | null;
  requestedAt: string; answeredAt: string; elapsedMs: number;
  method: string; path: string; body?: unknown;
  answer: { status: number; body: string; etag: string | null };
};
type ClosureState = {
  effective: boolean; failure?: string; prerequisite?: RequestEvidence;
  last: Partial<Record<PersonaName, RequestEvidence>>;
  history: RequestEvidence[];
};
const states = new WeakMap<PersonaSessions, ClosureState>();
const scope = 'governance:platform';
const permission = 'platform:resource:governance.rule.publish';
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) =>
  `actingSubject=${encodeURIComponent(person.actingSubject!)}`;

function state(sessions: PersonaSessions) {
  let current = states.get(sessions);
  if (current) return current;
  current = { effective: false, last: {}, history: [] };
  states.set(sessions, current);
  for (const name of personaNames) {
    const call = sessions[name].main;
    const proof = current;
    sessions[name].main = async (method, path, body, key, options) => {
      const requestedAt = new Date().toISOString();
      const started = performance.now();
      const response = await call(method, path, body, key, options);
      const answeredAt = new Date().toISOString();
      const elapsedMs = performance.now() - started;
      const copy = response.clone();
      const raw = copy.headers.get('content-type')?.includes('json')
        ? await copy.text()
        : `sha256:${createHash('sha256').update(new Uint8Array(await copy.arrayBuffer())).digest('hex')}`;
      proof.last[name] = { caller: sessions[name].accountId, actingSubject: sessions[name].actingSubject,
        requestedAt, answeredAt, elapsedMs, method, path, ...(body === undefined ? {} : { body }),
        answer: { status: response.status, body: raw, etag: response.headers.get('etag') } };
      proof.history.push(proof.last[name]!);
      return response;
    };
  }
  return current;
}

/** Setup refusals are kept separate from delivery evidence. No owner-store
 * write can stand in for the public journey this fixture qualifies. */
export async function closureSetup(sessions: PersonaSessions, prepare: () => Promise<void>) {
  const proof = state(sessions);
  try {
    await prepare();
    return null;
  } catch (error) {
    if (error instanceof TypeError || error instanceof DOMException) throw error;
    proof.failure = String(error);
    console.log('Realm closure setup', JSON.stringify({ realm: sessions.realm,
      phase: proof.effective ? 'delivery' : 'pre-closure', failure: proof.failure, prerequisite: proof.prerequisite,
      requests: proof.last }));
    return proof.failure;
  }
}

export async function closureCommand<T>(person: PersonaSession, method: string, path: string,
  body?: unknown, status = 200, key?: string, options?: Parameters<PersonaSession['main']>[4]): Promise<T> {
  const response = await person.main(method, path, body, key, options);
  const raw = await response.text();
  expect(response.status, `${method} ${path}: ${response.status} ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

type Grant = { id: string; permission: string; scopeId: string;
  recipient: { principalId?: string }; active: boolean; generation: string; validUntil: string | null };
type GrantResult = { authorityEpoch: string; grant: Grant };
type Rule = { ref: string; scopeId: string; revision: string; digest: string; replayed: boolean };
function ruleInput(person: PersonaSession, scopeId = scope) {
  return { profile: 'governance-rule-v1', ref: `urn:rezics:rule:${randomUUID()}`,
    scopeId, actingSubject: person.actingSubject, expectedRevision: null,
    document: { rule: 'Review the exact Realm record while preserving independent originals.' },
    idempotencyKey: randomUUID() };
}
/** Date headers have second resolution. A client clock cannot establish that
 * the server has passed a fractional grant deadline. Stay within the fixture's
 * existing HTTP exchange bound while obtaining a full-second expiry witness. */
export async function waitForPublisherExpiry(validUntil: string, read: () => Promise<Response>,
  pause: (milliseconds: number) => Promise<unknown> = Bun.sleep) {
  const expiresAt = Date.parse(validUntil);
  expect(Number.isFinite(expiresAt), 'Publisher grant must have a stored deadline').toBe(true);
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    const response = await read();
    const raw = await response.text();
    expect(response.status, `Publisher expiry clock read: ${response.status} ${raw}`).toBe(200);
    const serverDate = response.headers.get('date');
    const serverTime = Date.parse(serverDate ?? '');
    expect(Number.isFinite(serverTime), 'Publisher expiry requires the server Date header').toBe(true);
    const offsetMs = serverTime - expiresAt;
    if (offsetMs >= 1_000) return { validUntil, serverDate: serverDate!, offsetMs };
    await pause(1_000);
  }
  throw new Error('Publisher expiry server Date did not qualify within the HTTP exchange bound');
}

async function denied(person: PersonaSession, input: ReturnType<typeof ruleInput>) {
  const problem = await closureCommand<{ code: string }>(person, 'POST', '/v1/governance/rules',
    input, 403, input.idempotencyKey);
  expect(problem.code).toBe('governance_denied');
}

/** An administrator is tested without a designation first. Each subsequent
 * grant is an exact, bounded public issuance episode, consumed live by rules. */
export async function publishClosureRule(sessions: PersonaSessions): Promise<Rule> {
  const proof = state(sessions);
  const operator = sessions.operator;
  const episodeStart = proof.history.length;
  try {
    const administration = await closureCommand<{ groups: string[] }>(operator, 'GET', '/v1/me/platform-access');
    expect(administration.groups).toContain('platform-admin');
    await denied(sessions.owner, ruleInput(sessions.owner));
    await denied(operator, ruleInput(operator));
    const path = `/v1/access/grants?profile=platform-grants-v1&issuerSubject=${encodeURIComponent(operator.actingSubject!)}`;
    let page = await closureCommand<{ authorityEpoch: string; items: Grant[]; nextCursor: string | null }>(
      operator, 'GET', path);
    let principalId: string | undefined;
    const cursors = new Set<string>();
    for (;;) {
      principalId ??= page.items.find(grant => grant.permission === 'platform:grant')?.recipient.principalId;
      if (!page.nextCursor) break;
      expect(cursors.has(page.nextCursor), 'Grant cursor must advance').toBe(false);
      cursors.add(page.nextCursor);
      page = await closureCommand(operator, 'GET', `${path}&after=${page.nextCursor}`);
    }
    expect(principalId, 'The existing first-administrator bootstrap must expose its grant recipient').toBeDefined();
    const issue = async (validUntil: string) => {
      const latest = await closureCommand<{ authorityEpoch: string }>(operator, 'GET', path);
      const input = { profile: 'platform-grant-change-v1', issuerSubject: operator.actingSubject,
        expectedAuthorityEpoch: latest.authorityEpoch, grantId: randomUUID(), action: 'create',
        permission, scopeId: scope, recipient: { principalId }, validUntil };
      const response = await operator.main('POST', '/v1/access/grant-changes', input);
      const raw = await response.text();
      const request = proof.last.operator!;
      console.log('Realm rule publisher designation', JSON.stringify(request));
      if (response.status !== 200) proof.prerequisite = request;
      expect(response.status, JSON.stringify(request)).toBe(200);
      const result = JSON.parse(raw) as GrantResult;
      expect(result.grant).toMatchObject({ id: input.grantId, permission, scopeId: scope,
        recipient: { principalId }, active: true, validUntil });
      return result;
    };
    const revoke = async (result: GrantResult) => {
      const latest = await closureCommand<{ authorityEpoch: string }>(operator, 'GET', path);
      const revoked = await closureCommand<GrantResult>(operator, 'POST', '/v1/access/grant-changes', {
        profile: 'platform-grant-change-v1', issuerSubject: operator.actingSubject,
        expectedAuthorityEpoch: latest.authorityEpoch, grantId: result.grant.id, action: 'revoke',
        expectedObjectGeneration: result.grant.generation,
      });
      expect(revoked.grant.active).toBe(false);
    };
    const publish = async () => {
      const input = ruleInput(operator);
      const published = await closureCommand<Rule>(operator, 'POST', '/v1/governance/rules', input,
        201, input.idempotencyKey);
      expect(published).toMatchObject({ ref: input.ref, scopeId: scope, revision: '1', replayed: false });
      expect(published.digest).toMatch(/^[0-9a-f]{64}$/);
      const replay = await closureCommand<Rule>(operator, 'POST', '/v1/governance/rules', input,
        200, input.idempotencyKey);
      expect(replay).toEqual({ ...published, replayed: true });
      return { published, input };
    };
    const temporary = await issue(new Date(Date.now() + 3_000).toISOString());
    const expiring = await publish();
    await denied(operator, ruleInput(operator, `governance:realm:${sessions.realm}`));
    const expiry = await waitForPublisherExpiry(temporary.grant.validUntil!,
      () => operator.main('GET', path));
    // Even replay consumes live authority; an old publication receipt grants none.
    const expiredReplay = await operator.main('POST', '/v1/governance/rules', expiring.input,
      expiring.input.idempotencyKey);
    const expiredRaw = await expiredReplay.text();
    const replayDate = expiredReplay.headers.get('date');
    const offsetMs = Date.parse(replayDate ?? '') - Date.parse(expiry.validUntil);
    const expiredRequest = { ...proof.last.operator!, expiry,
      answer: { ...proof.last.operator!.answer, serverDate: replayDate, offsetMs } };
    console.log('Realm rule publisher expired replay', JSON.stringify(expiredRequest));
    if (expiredReplay.status !== 403 || !Number.isFinite(offsetMs) || offsetMs < 1_000)
      proof.prerequisite = expiredRequest;
    expect(offsetMs, JSON.stringify(expiredRequest)).toBeGreaterThanOrEqual(1_000);
    expect(expiredReplay.status, JSON.stringify(expiredRequest)).toBe(403);
    expect((JSON.parse(expiredRaw) as { code: string }).code).toBe('governance_denied');
    await denied(operator, ruleInput(operator));
    await revoke(temporary);
    const revocable = await issue(new Date(Date.now() + 3_600_000).toISOString());
    const revoked = await publish();
    await revoke(revocable);
    await denied(operator, revoked.input);
    await denied(operator, ruleInput(operator));
    const designated = await issue(new Date(Date.now() + 3_600_000).toISOString());
    try {
      return (await publish()).published;
    } finally {
      // Moderation consumes the immutable rule, not a standing publication power.
      await revoke(designated);
    }
  } finally {
    console.log('Realm publisher lifetime', JSON.stringify({ realm: sessions.realm,
      requests: proof.history.slice(episodeStart) }));
  }
}

export async function effectClosure(sessions: PersonaSessions, rule: Rule) {
  await (await prepareClosure(sessions, rule))();
}

/** Intake and review precede the held search read. Only enforcement races with
 * hydration, within the production search request's unchanged wall bound. */
export async function prepareClosure(sessions: PersonaSessions, rule: Rule) {
  const proof = state(sessions);
  const operator = sessions.operator;
  const header = await closureCommand<{ revision: string }>(sessions.owner, 'GET',
    `/v1/realms/${short(sessions.realm)}?${acting(sessions.owner)}`);
  const reportKey = randomUUID();
  const report = await closureCommand<{ reportId: string; caseId: string }>(sessions.owner,
    'POST', '/v1/public-reports', {
    profile: 'public-report-v1', actingSubject: sessions.owner.actingSubject,
    target: sessions.realm, category: 'spam_or_manipulation', contentLanguage: 'en',
    statement: 'Review only this Realm record; independently published originals retain credit.',
  }, 201, reportKey);
  // Public intake resolves and captures the live owner grain. The low-level
  // report writer cannot substitute fabricated graph-record evidence for it.
  const retained = await closureCommand<{ evidenceDigest: string;
    evidence: { owner: string; resource: string; component: string; state: string; revision: string | null }[] }>(sessions.owner, 'GET',
    `/v1/reports/${report.reportId}?${acting(sessions.owner)}`);
  expect(retained.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(retained.evidence).toHaveLength(1);
  expect(retained.evidence[0]).toMatchObject({ owner: 'graph', resource: sessions.realm, component: 'record',
    state: 'available', revision: header.revision });
  const claimKey = randomUUID();
  await closureCommand(operator, 'POST', `/v1/safety-cases/${report.caseId}/claim`, {
    actingSubject: operator.actingSubject, idempotencyKey: claimKey,
  }, 200, claimKey);
  const safety = await closureCommand<{ generation: string; reports: { evidenceDigest: string }[] }>(
    operator, 'GET', `/v1/safety-cases/${report.caseId}?${acting(operator)}`);
  expect(safety.reports[0]?.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(safety.reports[0]!.evidenceDigest).toBe(retained.evidenceDigest);
  const key = randomUUID();
  const input = { profile: 'moderation-decision-v1', caseId: report.caseId,
    expectedGeneration: safety.generation, actingSubject: operator.actingSubject, outcome: 'restrict',
    targets: [{ owner: 'graph', resource: sessions.realm, component: 'record', locator: null,
      scopeKind: 'component', revision: null, expectedHead: header.revision, effect: 'disclosure' }],
    rule: { ref: rule.ref, revision: rule.revision, digest: rule.digest },
    evidenceDigest: safety.reports[0]!.evidenceDigest, reversesDecisionId: null, answersStepId: null,
    rationale: 'Close only the exact reviewed Realm record.', disclosure: 'parties',
    reasons: { facts: 'The report and exact record were reviewed.', scope: 'This Realm record only.',
      duration: 'Until a later staff decision.', automation: false,
      appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en' },
    idempotencyKey: key };
  return async () => {
    const deadline = performance.now() + 30_000;
    let completed: { operation: { status: string; id?: string } } | undefined;
    while (performance.now() < deadline) {
      const response = await operator.main('POST', '/v1/moderation/decisions', input, key, { settle: false });
      const raw = await response.text();
      console.log('Realm closure decision', JSON.stringify({ request: input,
        answer: { status: response.status, body: raw } }));
      const result = JSON.parse(raw) as { operation: { status: string; id?: string } };
      if (response.status === 200 && result.operation.status === 'completed') { completed = result; break; }
      expect(response.status, raw).toBe(202);
      await Bun.sleep(100);
    }
    expect(completed, 'An accepted decision must become completed').toBeDefined();
    const replay = await closureCommand<{ operation: { status: string; id?: string } }>(operator,
      'POST', '/v1/moderation/decisions', input, 200, key, { settle: false });
    expect(replay.operation).toEqual(completed!.operation);
    proof.effective = true;
    // A completed receipt is followed by an actual public absence check.
    const path = `/v1/realms/${short(sessions.realm)}`;
    const response = await sessions.visitor.main('GET', path);
    const absent = await sessions.visitor.main('GET', `/v1/realms/${randomUUID()}`);
    expect(response.status, path).toBe(absent.status);
    expect(await response.json(), path).toEqual(await absent.json());
  };
}

export async function closeRealm(sessions: PersonaSessions): Promise<string | null> {
  return closureSetup(sessions, async () => { await effectClosure(sessions, await publishClosureRule(sessions)); });
}

/** Transparent storage transport: every query/command reaches the real QA
 * owner unchanged. Delay only a completed summary response, after its read
 * has finished, so closure can commit while Main still hydrates the old page. */
export function closureHydrationFence() {
  const upstream = new URL(Bun.env.FUSEKI_URL!);
  let targets: string[] = [];
  let expected = 0;
  let held = 0;
  let signalHeld: (() => void) | undefined;
  let heldPromise = Promise.resolve();
  let release: (() => void) | undefined;
  let released = Promise.resolve();
  const waiting: { count: number; resolve: () => void }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const incoming = new URL(request.url);
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
    const response = await fetch(new URL(incoming.pathname.slice(1) + incoming.search, upstream), {
      method: request.method, headers: request.headers, body,
      redirect: 'manual', signal: request.signal,
    });
    const query = body ? new TextDecoder().decode(body) : '';
    // Background summaries must not consume holds intended for public readers.
    if (held < expected && incoming.pathname.endsWith('/query')
      && request.headers.has('x-rezics-search-budget-ms')
      && /SELECT\s+\?epoch\s+\?sequence\s+\?hold\s+\?r\s+\?type\s+\?work/.test(query)
      && targets.some(target => query.includes(`<${target}>`))) {
      const bytes = await response.arrayBuffer();
      held++;
      if (held === expected) signalHeld?.();
      for (const waiter of waiting.filter(waiter => waiter.count <= held)) waiter.resolve();
      await released;
      return new Response(bytes, { status: response.status, headers: response.headers });
    }
    return response;
  } });
  return {
    url: server.url.toString(),
    arm(works: string[], readers: number) {
      targets = works; expected = readers; held = 0;
      waiting.length = 0;
      heldPromise = new Promise<void>(resolve => { signalHeld = resolve; });
      released = new Promise<void>(resolve => { release = resolve; });
    },
    async blocked(count = expected) {
      const reached = held >= count ? Promise.resolve() : count === expected ? heldPromise
        : new Promise<void>(resolve => { waiting.push({ count, resolve }); });
      await Promise.race([reached, Bun.sleep(10_000).then(() => {
        throw new Error(`Storage hydration fence held ${held} of ${count} real summary reads`);
      })]);
      console.log('Realm closure hydration fence', JSON.stringify({ held, expected }));
    },
    resume() { release?.(); },
    async close() { release?.(); await server.stop(true); },
  };
}

export async function closureRole(sessions: PersonaSessions, holder: PersonaSession, permissions: string[]) {
  const root = `/v1/realms/${short(sessions.realm)}`;
  const owner = sessions.owner;
  const roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: `Original fixture editors ${roleId}`, permissions },
    { kind: 'assignment', roleId, member: holder.actingSubject, assigned: true,
      validUntil: new Date(Date.now() + 3_600_000).toISOString() },
  ]) {
    const roles = await closureCommand<{ generation: string }>(owner, 'GET', `${root}/roles?${acting(owner)}`);
    const input = { actingSubject: owner.actingSubject, expectedGeneration: roles.generation,
      reason: 'Review original fixture publications and replies', change };
    const impact = await closureCommand<{ digest: string }>(owner, 'POST', `${root}/role-impact`, input);
    await closureCommand(owner, 'POST', `${root}/role-changes`, { ...input, impactDigest: impact.digest }, 201);
  }
}

export async function closureOriginal(author: PersonaSession, title: string) {
  const work = await closureCommand<{ work: string; mainVersion: string; workRevision: string }>(author,
    'POST', '/v1/works', { profile: 'metadata-only-v1', title, language: 'en',
      authoring: 'own-work', actingSubject: author.actingSubject }, 201);
  // Own-work creation supplies the native author credit atomically. Verify it
  // through the author's public API session before publishing the original.
  const credits = await closureCommand<{ items: { agent: string; role: string }[] }>(author,
    'GET', `/v1/works/${short(work.work)}/agent-credits?${acting(author)}`);
  expect(credits.items).toContainEqual(expect.objectContaining({ agent: author.actingSubject, role: 'author' }));
  const draft = await closureCommand<{ contribution: string; draftRevision: string }>(author,
    'POST', '/v1/contributions', { profile: 'text-contribution-v1', work: work.work, language: 'en',
      body: `Original fixture by its credited author Person: ${title}.`, actingSubject: author.actingSubject }, 201);
  const published = await closureCommand<{ publicationDecision: string }>(author,
    'POST', '/v1/contribution-publications', { profile: 'text-publication-v1', contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: author.actingSubject }, 201);
  await closureCommand(author, 'POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', work: work.work, contribution: draft.contribution,
    publicationDecision: published.publicationDecision, expectedSelectionHead: null,
    context: { kind: 'main-version-default', id: work.mainVersion }, selectionBasis: 'main-maintainer',
    actingSubject: author.actingSubject,
  }, 201);
  return { ...work, ...draft, ...published };
}

export async function closureCredit(person: PersonaSession, work: string, author: PersonaSession) {
  const query = person.actingSubject ? `?${acting(person)}` : '';
  await closureCommand(person, 'GET', `/v1/works/${short(work)}${query}`);
  const credits = await closureCommand<{ items: { agent: string; role: string }[] }>(person,
    'GET', `/v1/works/${short(work)}/agent-credits${query}`);
  expect(credits.items).toContainEqual(expect.objectContaining({ agent: author.actingSubject, role: 'author' }));
}

export async function closureReply(sessions: PersonaSessions, target: { work: string; workRevision: string },
  body: string, member = sessions.member, moderator = sessions.moderator) {
  const reply = `https://rezics.com/id/${randomUUID()}`;
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await closureCommand<{ revisionId: string; revisionDigest: string }>(member,
    'POST', '/v1/member-reply-drafts', { profile: 'member-reply-draft-v1', reply, variantId,
      rootTarget: target.work, rootRevision: target.workRevision, originRealm: sessions.realm,
      language: 'en', direction: 'ltr', expectedHead: null, body, actingSubject: member.actingSubject }, 201);
  await closureCommand(member, 'POST', '/v1/realm-replies', { profile: 'realm-reply-identity-v1',
    reply, variantId, revisionId: draft.revisionId, author: member.actingSubject,
    rootTarget: target.work, rootRevision: target.workRevision,
    parentReply: null, parentRevision: null, contextRevision: null }, 201);
  const review = await closureCommand<{ decisionId: string }>(moderator, 'POST', '/v1/realm-reply-reviews', {
    profile: 'realm-reply-review-v1', realm: sessions.realm, reply,
    revisionId: draft.revisionId, revisionDigest: draft.revisionDigest, expectedGeneration: '0',
    supersedes: null, outcome: 'approved', method: 'human', methodRevision: 'realm-manager-v1',
    dependencyDigest: createHash('sha256').update(target.work).digest('hex'),
    reasonReference: null, actingSubject: moderator.actingSubject,
  }, 201);
  await closureCommand(moderator, 'POST', '/v1/realm-reply-placements', {
    profile: 'realm-reply-placement-v1', realm: sessions.realm, reply, revisionId: draft.revisionId,
    revisionDigest: draft.revisionDigest, reviewDecisionId: review.decisionId,
    expectedHead: null, actingSubject: moderator.actingSubject,
  }, 201);
  return { reply, ...draft };
}

/** Emit a complete persona matrix, including the public request/answer that
 * explains a pending cell. Expected-failure registration stays in outcomeTest. */
export async function closureCell(declaration: RowOutcomes, name: PersonaName,
  sessions: () => PersonaSessions, run: () => Promise<void>) {
    const proof = state(sessions());
    delete proof.last[name];
    proof.history = [];
    try {
      await run();
      console.log('Realm closure cell', JSON.stringify({ row: declaration.rowId, persona: name,
        result: 'passed', phase: name === 'visitor' && declaration.rowId.endsWith('notifications')
          ? 'authentication' : proof.effective ? 'delivery' : 'pre-closure' }));
    } catch (error) {
      console.log('Realm closure cell', JSON.stringify({ row: declaration.rowId, persona: name,
        result: 'pending', phase: proof.effective ? 'delivery' : 'pre-closure',
        prerequisite: proof.prerequisite,
        request: proof.history.find(request => String(error).includes(request.path)) ?? proof.last[name],
        failure: String(error) }));
      throw error;
    }
}
