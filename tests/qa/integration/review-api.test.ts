import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { engageAccessRecoveryFence, releaseAccessRecoveryFence }
  from '../../../services/main/src/modules/access/admission.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { ReaderReviews } from '../../../services/main/src/modules/review/store.ts';
import { ReviewReportOwner } from '../../../services/main/src/modules/governance/report-review.ts';
import { GLOBAL_CONTEXT, GovernanceStore } from '../../../services/main/src/modules/governance/store.ts';
import { GovernanceRules } from '../../../services/main/src/modules/governance/rules.ts';
import { NotificationProducer } from '../../../services/main/src/modules/notification-producers/producer.ts';
import type { NotificationEvent } from '../../../services/main/src/modules/notification/store.ts';
import { reviewSubject } from '../../../services/main/src/modules/notification/producer-review.ts';
import { ReadRankingProjection } from '../../../services/main/src/modules/rankings/projection.ts';
import { startMediaStack } from './media-support.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('G315: reviews bind a current rating, serialize person CAS, hide spoilers and count helpful people', async () => {
  const stack = await startMediaStack('reader-review');
  try {
    const a = await stack.member('review-a'), b = await stack.member('review-b');
    const principals = new Map([[a.token, a.principal], [b.token, b.principal]]);
    const account = { verify: async (request: Request, scopes: readonly string[]) => {
      const principal = principals.get(request.headers.get('authorization')?.replace('Bearer ', '') ?? '');
      if (!principal) throw new AccountAssertionDenied('Authentication required');
      if (request.headers.has('x-read-only') && scopes.some(scope => ['rating:submit', 'feed:vote'].includes(scope))) {
        throw new AccountAssertionDenied('Write scope required');
      }
      const verified = { ...principal, emailVerified: true };
      return { ...verified, currentAssertion: async () => verified };
    } };
    stack.access.configureBaseline(stack.fuseki);
    const libraryStatus = new ReaderLibraryStatusStore(stack.contentPool);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access, account,
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      reviews: new ReaderReviews(stack.accessPool), libraryStatus });
    const call = (method: string, path: string, body?: unknown, token?: string,
      key = randomUUID(), readOnly = false) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}),
        ...(readOnly ? { 'x-read-only': 'true' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const agent = async (name: string, token: string) => (await json<{ agent: string }>(
      await call('POST', '/v1/agents', { profile: 'agent-provision-v1', kind: 'person', displayName: name }, token), 201)).agent;
    const author = await agent('Review author', a.token);
    const authorSecond = await agent('Second pen name', a.token);
    const voter = await agent('Helpful reader', b.token);
    const grant = async (principalId: string, subject: string, scope: string, action: string) => {
      await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principalId, subject, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), subject, scope, action]);
    };
    const work = await stack.publicWork(author, ['en'], 'A reviewed Work');
    await grant(a.principalId, author, 'space:create:root', 'space.create');
    const realm = await json<{ realm: string }>(await call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Readers', capabilities: ['realm'], actingSubject: author }, a.token), 201);
    await grant(a.principalId, author, `rating:context:${realm.realm}`, 'rating.context.create');
    const context = await json<{ context: string }>(await call('POST', '/v1/rating-contexts', {
      profile: 'realm-standing-rating-context-v1', realm: realm.realm,
      question: 'How good was this Work?', actingSubject: author }, a.token), 201);
    await grant(a.principalId, author, `rating:observe:${context.context}`, 'rating.observation.set');
    await json(await call('POST', '/v1/rating-observations', {
      profile: 'realm-standing-rating-observation-v1', context: context.context,
      work: work.work, mainVersion: work.mainVersion, expectedRevisionHead: null,
      value: 8, actingSubject: author }, a.token), 201);
    await libraryStatus.write({ agent: author, work: work.work, status: 'read',
      startedOn: '2026-01-01', finishedOn: '2026-01-08', expectedVersion: 0,
      idempotencyKey: randomUUID() });

    const body = { profile: 'reader-review-command-v1', actingSubject: author,
      context: context.context, work: work.work, expectedRevision: null,
      language: 'en', text: 'A spoiler about the ending', spoiler: true };
    const key = randomUUID();
    expect((await call('POST', '/v1/reviews', body, a.token, randomUUID(), true)).status).toBe(401);
    const first = await json<{ review: string; revision: string }>(await call('POST', '/v1/reviews', body, a.token, key), 201);
    expect(await json(await call('POST', '/v1/reviews', body, a.token, key)))
      .toMatchObject({ review: first.review, revision: first.revision, replayed: true });
    expect((await call('POST', '/v1/reviews', { ...body, text: 'Another intent' }, a.token, key)).status).toBe(409);
    expect((await call('POST', '/v1/reviews', { ...body, actingSubject: authorSecond }, a.token)).status).toBe(409);
    const path = `/v1/works/${work.work.slice(-36)}/reviews?context=${encodeURIComponent(context.context)}`;
    const publicPage = await json<{ items: Array<{ id: string; text: string | null; spoilerWithheld: boolean;
      startedOn: string | null; finishedOn: string | null; rating: number }> }>(await call('GET', path));
    expect(publicPage.items).toMatchObject([{ id: first.review, text: null, spoilerWithheld: true,
      startedOn: '2026-01-01', finishedOn: '2026-01-08', rating: 8 }]);
    const ownPage = await json<{ items: Array<{ id: string; text: string }> }>(await call('GET',
      `${path}&actingSubject=${encodeURIComponent(author)}&showSpoilers=true`, undefined, a.token));
    expect(ownPage.items[0]).toMatchObject({ id: first.review, text: body.text });
    expect((await call('POST', '/v1/reviews', { ...body, actingSubject: voter,
      text: 'A second perspective', spoiler: false }, b.token)).status).toBe(403);
    await grant(b.principalId, voter, `rating:observe:${context.context}`, 'rating.observation.set');
    await json(await call('POST', '/v1/rating-observations', {
      profile: 'realm-standing-rating-observation-v1', context: context.context,
      work: work.work, mainVersion: work.mainVersion, expectedRevisionHead: null,
      value: 6, actingSubject: voter }, b.token), 201);
    const second = await json<{ review: string }>(await call('POST', '/v1/reviews', {
      ...body, actingSubject: voter, text: 'A second perspective', spoiler: false }, b.token), 201);
    const firstPage = await json<{ items: Array<{ id: string }>; nextCursor: string | null }>(
      await call('GET', `${path}&actingSubject=${encodeURIComponent(author)}&limit=1`, undefined, a.token));
    expect(firstPage.items.map(item => item.id)).toEqual([first.review]);
    expect(firstPage.nextCursor).not.toBeNull();
    const nextPage = await json<{ items: Array<{ id: string }>; nextCursor: string | null }>(
      await call('GET', `${path}&actingSubject=${encodeURIComponent(author)}&limit=1&cursor=${firstPage.nextCursor}`,
        undefined, a.token));
    expect(nextPage.items.map(item => item.id)).toEqual([second.review]);
    expect(nextPage.nextCursor).toBeNull();
    expect((await call('GET', `${path}&sort=new&cursor=${firstPage.nextCursor}`)).status).toBe(400);
    expect((await call('PUT', `/v1/reviews/${first.review}/helpful`, { profile: 'reader-review-helpful-v1',
      actingSubject: authorSecond, helpful: true, expectedRevision: null }, a.token)).status).toBe(403);
    const vote = await json<{ revision: string; helpfulCount: number }>(await call('PUT',
      `/v1/reviews/${first.review}/helpful`, { profile: 'reader-review-helpful-v1',
        actingSubject: voter, helpful: true, expectedRevision: null }, b.token));
    expect(vote.helpfulCount).toBe(1);
    expect((await call('PUT', `/v1/reviews/${first.review}/helpful`, { profile: 'reader-review-helpful-v1',
      actingSubject: voter, helpful: false, expectedRevision: null }, b.token)).status).toBe(409);
    const edit = { ...body, expectedRevision: first.revision, text: 'A quotable recommendation', spoiler: false };
    const racing = await Promise.all([edit, { ...edit, text: 'A different correction' }]
      .map(value => call('POST', '/v1/reviews', value, a.token)));
    expect(racing.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = await json<{ revision: string }>(racing.find(response => response.status === 200)!);
    const quote = await json<{ items: Array<{ review: string; excerpt: string }> }>(await call('GET',
      `/v1/review-quotes/realms/${realm.realm.slice(-36)}`));
    expect(quote.items[0]).toMatchObject({ review: first.review });
    expect(quote.items[0]!.excerpt.length).toBeGreaterThan(0);
    const contentOwner = await stack.content.ownerPosition();
    const rankingContent = { ownerPosition: async () => ({ ...contentOwner, sequence: '0' }),
      readOutbox: async () => [] } as unknown as ContentCore;
    const projection = new ReadRankingProjection(stack.accessPool, rankingContent,
      stack.contentPool, stack.env);
    const rank = async () => {
      for (let i = 0; i < 100 && await projection.tick() > 0; i++) { /* bounded owner catch-up */ }
      const checkpoint = await projection.current();
      return projection.candidates(checkpoint.generation, 'reviews', 'day',
        new Date().toISOString().slice(0, 10), 'score', null, 100);
    };
    expect((await rank()).find(item => item.work === work.work)?.score).toBe('2');
    const rankingApp = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      account, readRankings: projection, media: stack.media, mediaAccess: stack.mediaAccess });
    const rankingResponse = await rankingApp.handle(new Request(
      'http://main.local/v1/rankings/trending?metric=reviews&interval=day'));
    expect(rankingResponse.status).toBe(200);
    expect(await rankingResponse.json()).toMatchObject({ metric: 'reviews',
      items: [{ id: work.work, score: 2 }] });
    const notices: NotificationEvent[] = [];
    const producer = new NotificationProducer(stack.accessPool, null, stack.contentPool,
      stack.fuseki, { enqueue: async event => { notices.push(event); return []; } }, null);
    const drain = async () => {
      for (let i = 0; i < 100 && await producer.runAccessOnce() > 0; i++) { /* durable cursor catch-up */ }
    };
    await drain();
    expect(notices.filter(item => item.topic === 'review')).toMatchObject([{
      recipients: [a.principalId], subject: { ref: second.review } }]);
    expect((await reviewSubject(stack.accessPool, stack.fuseki, { principalId: a.principalId,
      owner: 'access', ref: second.review, revision: null, disclosureBasis: 'review-created-v1',
      realm: realm.realm })).status).toBe('available');
    for (let i = 0; i < 4; i++) {
      const person = await stack.member(`helpful-${i}`);
      principals.set(person.token, person.principal);
      const personAgent = await agent(`Helpful person ${i}`, person.token);
      await new ReaderReviews(stack.accessPool).helpful({ ...person.principal, emailVerified: true }, first.review,
        personAgent, true, null, randomUUID(), async () => {});
    }
    await drain();
    expect(notices.filter(item => item.topic === 'review-helpful')).toMatchObject([{
      recipients: [a.principalId], subject: { ref: first.review } }]);
    const milestone = await stack.accessPool.query(`SELECT milestone FROM access.reader_review_milestone
      WHERE review_id = $1`, [first.review]);
    expect(milestone.rows).toEqual([{ milestone: 5 }]);

    const reviewOwner = new ReviewReportOwner(stack.accessPool, stack.access, stack.env);
    const rules = new GovernanceRules(stack.accessPool);
    const governance = new GovernanceStore(stack.accessPool, { capture: (principal, actor, target) =>
      reviewOwner.capture(principal, actor, target) }, { current: target => reviewOwner.current(target) },
    rules, undefined, reviewOwner);
    const scope = `governance:platform:${randomUUID()}`;
    await grant(a.principalId, authorSecond, scope, 'governance.rule.publish');
    await grant(a.principalId, authorSecond, scope, 'governance.moderate');
    const evidence = { owner: 'review' as const, resource: first.review, component: 'body' as const,
      revision: winner.revision, locator: null };
    const former = await reviewOwner.capture(b.principal, voter,
      { ...evidence, revision: first.revision });
    const current = await reviewOwner.capture(b.principal, voter, evidence);
    expect(former.revisionDigest).not.toBe(current.revisionDigest);
    const report = await governance.submitReport(b.principal, {
      kind: 'content_report', actingSubject: voter, authority: { kind: 'platform', scopeId: scope },
      context: GLOBAL_CONTEXT, target: { owner: 'review', resource: first.review, component: 'body' },
      disclosure: 'parties', reasonCode: 'review_abuse', statement: 'Reported exact review revision',
      evidence: [evidence], idempotencyKey: randomUUID(),
    });
    expect(report.evidence).toMatchObject([{ owner: 'review', revision: winner.revision,
      state: 'available' }]);
    expect(report.evidence[0]?.revisionDigest).toMatch(/^[0-9a-f]{64}$/);
    const rule = await rules.publish(a.principal, { ref: `urn:rezics:rule:${randomUUID()}`,
      scopeId: scope, actingSubject: authorSecond, expectedRevision: null,
      document: { policy: 'review body disclosure' }, idempotencyKey: randomUUID() });
    const target = { ...evidence, scopeKind: 'exact_revision' as const,
      expectedHead: winner.revision, effect: 'disclosure' as const };
    const decision = { caseId: report.caseId, expectedGeneration: '0', actingSubject: authorSecond,
      outcome: 'restrict' as const, targets: [target], rule,
      evidenceDigest: report.evidenceDigest, reversesDecisionId: null, answersStepId: null,
      rationale: 'Exact reported body', disclosure: 'parties' as const, idempotencyKey: randomUUID() };
    await expect(governance.decide(a.principal, { ...decision, targets: [{ ...target,
      expectedHead: first.revision }] })).rejects.toThrow('target changed since review');
    await governance.decide(a.principal, decision);
    expect((await call('GET', `/v1/reviews/${first.review}`)).status).toBe(404);
    expect((await json<{ items: Array<{ review: string }> }>(await call('GET',
      `/v1/review-quotes/realms/${realm.realm.slice(-36)}`))).items
      .some(item => item.review === first.review)).toBe(false);
    expect((await rank()).find(item => item.work === work.work)?.score).toBe('1');
    const helpfulSubject = { principalId: a.principalId, owner: 'access', ref: first.review,
      revision: null, disclosureBasis: 'review-helpful-v1', realm: realm.realm };
    expect((await reviewSubject(stack.accessPool, stack.fuseki, helpfulSubject)).status).toBe('undisclosed');
    expect((await call('POST', '/v1/reviews', { ...edit, expectedRevision: winner.revision }, a.token)).status)
      .toBe(403);
    await governance.decide(a.principal, { ...decision, outcome: 'restore', expectedGeneration: '1',
      idempotencyKey: randomUUID() });
    expect((await call('GET', `/v1/reviews/${first.review}`)).status).toBe(200);
    expect((await reviewSubject(stack.accessPool, stack.fuseki, helpfulSubject)).status).toBe('available');
    expect((await rank()).find(item => item.work === work.work)?.score).toBe('2');
    const previousGeneration = (await projection.current()).generation;
    const reset = new ReadRankingProjection(stack.accessPool, rankingContent, stack.contentPool,
      { ...stack.env, lineage: { ...stack.env.lineage, dataEpoch: randomUUID() } });
    for (let i = 0; i < 100 && await reset.tick() > 0; i++) { /* source replay */ }
    const rebuilt = await reset.current();
    expect(rebuilt.generation).not.toBe(previousGeneration);
    expect((await reset.candidates(rebuilt.generation, 'reviews', 'day',
      new Date().toISOString().slice(0, 10), 'score', null, 100))
      .find(item => item.work === work.work)?.score).toBe('2');
    const deleted = await json<{ deleted: boolean }>(await call('DELETE', `/v1/reviews/${first.review}`,
      { profile: 'reader-review-delete-v1', actingSubject: author, expectedRevision: winner.revision }, a.token));
    expect(deleted.deleted).toBe(true);
    expect((await call('GET', `/v1/reviews/${first.review}`)).status).toBe(404);
    expect((await reviewSubject(stack.accessPool, stack.fuseki, helpfulSubject)).status).toBe('undisclosed');
    const emptyQuotes = await json<{ items: unknown[] }>(await call('GET',
      `/v1/review-quotes/realms/${realm.realm.slice(-36)}`));
    expect(emptyQuotes.items).toMatchObject([{ review: second.review }]);
    const events = await new ReaderReviews(stack.accessPool).eventsAfter('0');
    expect(events.map(event => event.kind)).toEqual([
      'created', 'created', 'helpful-changed', 'edited',
      'helpful-changed', 'helpful-changed', 'helpful-changed', 'helpful-changed', 'deleted']);
    expect((await rank()).find(item => item.work === work.work)?.score).toBe('1');
    expect(events.every(event => event.work === work.work && event.context === context.context)).toBe(true);
    expect(await new ReaderReviews(stack.accessPool).eventsAfter(events[2]!.sequence, 1))
      .toMatchObject([{ kind: 'edited' }]);
    const generation = await engageAccessRecoveryFence(stack.accessPool);
    try {
      expect((await call('GET', path)).status).toBe(503);
      await expect(new ReaderReviews(stack.accessPool).eventsAfter('0')).rejects.toThrow();
    } finally { await releaseAccessRecoveryFence(stack.accessPool, generation); }
    expect((await call('GET', path)).status).toBe(200);
  } finally { await stack.stop(); }
});
