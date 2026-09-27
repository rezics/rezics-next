import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { ManagementReadStore } from '../../../services/main/src/modules/management-reads/read-store.ts';
import { RealmSubmissionReads } from '../../../services/main/src/modules/realm-submission/reads.ts';
import { RealmSubmissionStore } from '../../../services/main/src/modules/realm-submission/store.ts';
import { SUBMISSION_COST, SubmissionUnavailable, type DecisionInput, type SubmissionInput,
  type SubmissionView } from '../../../services/main/src/modules/realm-submission/schema.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { realmSelectionSlotIri } from '../../../services/main/src/modules/work/select-realm.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';

type Member = Awaited<ReturnType<MediaStack['member']>>;
type Result = { submission: SubmissionView; replayed: boolean };
interface Page<T> { items: T[]; nextCursor: string | null }
const short = (id: string) => id.slice(-36);

test('Realm submissions: exact adoption, private decisions, stale offers, races, recovery and bounded isolated reads', async () => {
  const stack = await startMediaStack('realm-submission');
  try {
    const author = await stack.member('author');
    const moderator = await stack.member('reviewer');
    const moderator2 = await stack.member('reviewer-two');
    const outsider = await stack.member('outsider');
    const members = [author, moderator, moderator2, outsider];
    const makeRealm = async () => {
      await moderator.grant('space:create:root', 'space.create');
      const response = await moderator.send('POST', '/v1/spaces', { profile: 'space-realm-v1',
        name: 'Submission Realm', capabilities: ['realm'], actingSubject: moderator.actor });
      expect(response.status).toBe(201);
      return (await response.json() as { realm: string }).realm;
    };
    const realm = await makeRealm();
    const otherRealm = await makeRealm();
    for (const target of [realm, otherRealm]) {
      await author.grant(`submission:submit:${target}`, 'submission.submit');
      await author.grant(`submission:submit:${target}`, 'submission.withdraw');
      await moderator.grant(`review:decide:${target}`, 'review.decide');
      await moderator.grant(`publication:adopt:${target}`, 'publication.adopt');
    }
    await moderator2.grant(`review:decide:${realm}`, 'review.decide');
    await moderator2.grant(`publication:adopt:${realm}`, 'publication.adopt');
    let ownerSql = 0;
    const ownerPool = new Proxy(stack.accessPool, { get(target, property) {
      if (property === 'connect') return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(connection, member) {
          if (member === 'query') return (...args: unknown[]) => {
            ownerSql++;
            return Reflect.apply(connection.query, connection, args);
          };
          const value = Reflect.get(connection, member);
          return typeof value === 'function' ? value.bind(connection) : value;
        } });
      };
      if (property === 'query') return (...args: unknown[]) => {
        ownerSql++;
        return Reflect.apply(target.query, target, args);
      };
      return Reflect.get(target, property);
    } });
    let reviewConsent = true;
    const makeApp = () => createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      realmSubmissions: new RealmSubmissionStore(ownerPool, stack.access, stack.env),
      realmSubmissionReads: new RealmSubmissionReads(ownerPool),
      managementReads: new ManagementReadStore(ownerPool, stack.env),
      account: { verify: async (request, scopes) => {
        if (!reviewConsent && scopes?.includes('realm:adopt')) throw new AccountAssertionDenied('scope unavailable');
        const found = members.find(member => request.headers.get('authorization') === `Bearer ${member.token}`);
        if (!found) throw new AccountAssertionDenied('missing bearer');
        return found.principal;
      } } });
    let app = makeApp();
    const call = (member: Member | null, method: string, path: string, body?: unknown, key = randomUUID()) =>
      app.handle(new Request(`http://main.test${path}`, { method, headers: {
        ...(member ? { authorization: `Bearer ${member.token}` } : {}),
        'content-type': 'application/json', 'idempotency-key': key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const root = (target = realm) => `/v1/realms/${short(target)}/submissions`;
    const read = (member: Member, path: string) => call(member, 'GET',
      `${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(member.actor)}`);
    const queue = (member = moderator, target = realm, suffix = '') => read(member,
      `/v1/realms/${short(target)}/moderation?type=contribution_submission${suffix}`);
    const candidate = async (): Promise<SubmissionInput> => {
      const work = await stack.privateWork(author.actor);
      const contribution = await stack.contribution(work.work, author.actor, 'en', 'Exact offered text');
      const rows = (await stack.fuseki.query(`SELECT ?draft WHERE { GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(contribution.decision)} <${RV}selectedDraft> ?draft } }`)).results!.bindings;
      return { actingSubject: author.actor, kind: 'contribution', work: work.work,
        mainVersion: work.mainVersion, contribution: contribution.contribution,
        publicationDecision: contribution.decision, selectedDraft: rows[0]!.draft!.value, correctionOf: null };
    };
    const submit = async (input: SubmissionInput, target = realm, key = randomUUID()) => {
      const response = await call(author, 'POST', root(target), input, key);
      expect(response.status).toBe(201);
      return (await response.json() as Result).submission;
    };
    const decision = (row: SubmissionView, outcome: DecisionInput['outcome'] = 'accept',
      member = moderator): DecisionInput => ({ actingSubject: member.actor, expectedRevision: row.revision,
      outcome, expectedSelectionHead: row.correctionOf, publicReason: outcome === 'accept' ? null : 'Please clarify the source.',
      internalNote: 'Private moderator note' });
    const decide = (row: SubmissionView, body = decision(row), member = moderator, key = randomUUID()) =>
      call(member, 'POST', `${root(row.realm)}/${row.id}/decisions`, body, key);
    const withdraw = (row: SubmissionView) => call(author, 'POST', `${root(row.realm)}/${row.id}/withdrawals`,
      { actingSubject: author.actor, expectedRevision: row.revision });
    const selected = async (input: SubmissionInput, target = realm) => {
      const rows = (await stack.fuseki.query(`SELECT ?selection WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(realmSelectionSlotIri(target, input.mainVersion))} <${RV}selectionHead> ?selection } }`)).results!.bindings;
      return rows[0]?.selection?.value ?? null;
    };

    const firstInput = await candidate();
    expect((await call(null, 'POST', root(), firstInput)).status).toBe(401);
    expect((await call(outsider, 'POST', root(), { ...firstInput, actingSubject: outsider.actor })).status).toBe(403);
    await outsider.grant(`submission:submit:${realm}`, 'submission.submit');
    expect((await call(outsider, 'POST', root(), { ...firstInput, actingSubject: outsider.actor })).status).toBe(404);
    const submissionKey = randomUUID();
    const first = await submit(firstInput, realm, submissionKey);
    expect(first.state).toBe('pending');
    expect((await call(author, 'POST', root(), firstInput, submissionKey)).status).toBe(200);
    expect((await call(author, 'POST', root(), { ...firstInput, selectedDraft: `https://rezics.com/id/${randomUUID()}` },
      submissionKey)).status).toBe(409);
    expect((await decide(first, decision(first, 'accept', outsider), outsider)).status).toBe(403);
    expect((await queue(outsider)).status).toBe(404);
    expect((await read(outsider, `${root()}/${first.id}`)).status).toBe(404);
    expect((await call(moderator, 'POST', `${root(otherRealm)}/${first.id}/decisions`, decision(first))).status).toBe(404);
    const sameOfferElsewhere = await submit(firstInput, otherRealm);
    const beforeQueue = stack.fuseki.queries;
    const queueResponse = await queue();
    expect(queueResponse.status).toBe(200);
    expect(queueResponse.headers.get('cache-control')).toBe('private, no-store');
    expect(stack.fuseki.queries - beforeQueue).toBe(2);
    const queuePage = await queueResponse.json() as Page<{ id: string; submission: { selectedDraft: string } }>;
    expect(queuePage.items.map(item => item.id)).toEqual([first.id]);
    expect(queuePage.items[0]!.submission.selectedDraft).toBe(firstInput.selectedDraft);
    await moderator.grant(`governance:realm:${realm}`, 'governance.moderate');
    const mixed = await read(moderator, `/v1/realms/${short(realm)}/moderation`);
    expect(mixed.status).toBe(200);
    expect((await mixed.json() as Page<{ id: string }>).items.map(item => item.id)).toEqual([first.id]);
    reviewConsent = false;
    const consentLimited = await read(moderator, `/v1/realms/${short(realm)}/moderation`);
    expect(consentLimited.status).toBe(200);
    expect((await consentLimited.json() as Page<unknown>).items).toEqual([]);
    expect((await queue()).status).toBe(401);
    reviewConsent = true;
    expect((await queue(moderator, otherRealm).then(r => r.json()) as Page<{ id: string }>).items[0]!.id)
      .toBe(sameOfferElsewhere.id);
    expect((await read(moderator2, `${root(otherRealm)}/${sameOfferElsewhere.id}`)).status).toBe(404);

    const deniedDecision = decision(first, 'reject');
    expect((await decide(first, { ...deniedDecision, publicReason: null })).status).toBe(400);
    const rejected = await decide(first, deniedDecision);
    expect(rejected.status).toBe(200);
    expect((await rejected.json() as Result).submission.state).toBe('rejected');
    expect(await selected(firstInput)).toBeNull();
    const privateDetail = await read(moderator, `${root()}/${first.id}`);
    expect((await privateDetail.json() as { internalNote: string }).internalNote).toBe('Private moderator note');
    const authorPage = await read(author, '/v1/my/submissions');
    expect(authorPage.status).toBe(200);
    const authorText = await authorPage.text();
    expect(authorText).not.toContain('internalNote');
    expect(authorText).not.toContain('Private moderator note');
    expect(authorText).toContain('Please clarify the source.');
    expect((await read(outsider, '/v1/my/submissions').then(r => r.json()) as Page<unknown>).items).toEqual([]);
    expect((await call(outsider, 'GET', `/v1/my/submissions?actingSubject=${encodeURIComponent(author.actor)}`)).status).toBe(404);
    await outsider.grant(`governance:realm:${realm}`, 'governance.moderate');
    const governanceOnly = await read(outsider, `/v1/realms/${short(realm)}/moderation`);
    expect(governanceOnly.status).toBe(200);
    expect((await governanceOnly.json() as Page<unknown>).items).toEqual([]);
    expect((await queue(outsider)).status).toBe(404);

    const acceptInput = await candidate();
    const offered = await submit(acceptInput);
    const graphCalls = stack.fuseki.queries;
    const sqlCalls = ownerSql;
    const acceptedResponse = await decide(offered);
    expect(acceptedResponse.status).toBe(200);
    expect(stack.fuseki.queries - graphCalls).toBeLessThanOrEqual(SUBMISSION_COST.commandGraphCalls);
    expect(ownerSql - sqlCalls).toBeLessThanOrEqual(SUBMISSION_COST.ownerSqlStatements);
    const accepted = (await acceptedResponse.json() as Result).submission;
    expect(accepted).toMatchObject({ state: 'accepted', selectedDraft: acceptInput.selectedDraft });
    expect(accepted.adoptionReceipt).toBeString();
    expect(await selected(acceptInput)).toBe(accepted.selection);
    expect((await withdraw(accepted)).status).toBe(409);
    // A Realm selection exists while this Work still has no Main selection.
    const global = (await stack.fuseki.query(`SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(acceptInput.mainVersion)} <${RV}selectionHead> ?head } }`)).results!.bindings;
    expect(global).toEqual([]);

    const corrected = await stack.contribution(acceptInput.work, author.actor, 'en', 'Corrected exact text');
    const correctionDraft = (await stack.fuseki.query(`SELECT ?draft WHERE { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(corrected.decision)} <${RV}selectedDraft> ?draft } }`)).results!.bindings[0]!.draft!.value;
    const correction = await submit({ ...acceptInput, kind: 'correction', correctionOf: accepted.selection,
      contribution: corrected.contribution, publicationDecision: corrected.decision, selectedDraft: correctionDraft });
    expect((await decide(correction, { ...decision(correction), expectedSelectionHead: null })).status).toBe(409);
    const correctionAccepted = await decide(correction);
    expect(correctionAccepted.status).toBe(200);
    expect((await correctionAccepted.json() as Result).submission).toMatchObject({ state: 'accepted',
      selectedDraft: correctionDraft, correctionOf: accepted.selection });

    const changes = await submit(await candidate());
    const requested = await decide(changes, decision(changes, 'request-changes'));
    expect(requested.status).toBe(200);
    const requestedRow = (await requested.json() as Result).submission;
    expect(requestedRow.state).toBe('changes-requested');
    expect((await withdraw(requestedRow)).status).toBe(200);

    const staleInput = await candidate();
    const staleOffer = await submit(staleInput);
    await author.grant(`contribution:edit:${staleInput.contribution}`, 'contribution.edit');
    await author.grant(`contribution:publish:${staleInput.contribution}`, 'contribution.publish');
    const edited = await author.send('POST', '/v1/contribution-edits', { profile: 'text-contribution-v1',
      contribution: staleInput.contribution, expectedHead: staleInput.selectedDraft,
      body: 'Superseding text', actingSubject: author.actor });
    expect(edited.status).toBe(200);
    const draft = (await edited.json() as { draftRevision: string }).draftRevision;
    const published = await author.send('POST', '/v1/contribution-publications', { profile: 'text-publication-v1',
      contribution: staleInput.contribution, expectedDraftHead: draft,
      expectedPublicationHead: staleInput.publicationDecision, rightsBasis: 'original-contribution',
      disclosure: 'public', actingSubject: author.actor });
    expect(published.status).toBe(201);
    const staleDecision = await decide(staleOffer);
    expect(staleDecision.status).toBe(200);
    expect((await staleDecision.json() as Result).submission.state).toBe('stale');
    expect(await selected(staleInput)).toBeNull();

    const concurrent = await submit(await candidate());
    const decisions = await Promise.all([decide(concurrent),
      decide(concurrent, decision(concurrent, 'accept', moderator2), moderator2)]);
    expect(decisions.map(response => response.status).sort()).toEqual([200, 409]);
    const raced = await submit(await candidate());
    const race = await Promise.all([decide(raced), withdraw(raced)]);
    expect(race.map(response => response.status).sort()).toEqual([200, 409]);
    const withdrawnInput = await candidate();
    const withdrawalFirst = await submit(withdrawnInput);
    const withdrawnResponse = await withdraw(withdrawalFirst);
    expect(withdrawnResponse.status).toBe(200);
    const withdrawn = (await withdrawnResponse.json() as Result).submission;
    expect((await decide(withdrawn)).status).toBe(409);
    expect(await selected(withdrawnInput)).toBeNull();

    // Lost SQL-command acknowledgement: immutable replay, even if the initial
    // admission expires before the client sees its successful response.
    const acknowledgementInput = await candidate();
    const acknowledgementKey = randomUUID();
    const originalRecord = stack.access.recordGraphOutcome.bind(stack.access);
    let acknowledgementLost = false;
    stack.access.recordGraphOutcome = async (id, proof) => {
      if (!acknowledgementLost && proof.scope === `submission:submit:${realm}`) {
        acknowledgementLost = true;
        throw new SubmissionUnavailable('Injected acknowledgement loss');
      }
      return originalRecord(id, proof);
    };
    expect((await call(author, 'POST', root(), acknowledgementInput, acknowledgementKey)).status).toBe(503);
    stack.access.recordGraphOutcome = originalRecord;
    await stack.accessPool.query(`UPDATE access.admission SET expires_at = clock_timestamp() - interval '1 second'
      WHERE idempotency_key = $1`, [acknowledgementKey]);
    const acknowledged = await call(author, 'POST', root(), acknowledgementInput, acknowledgementKey);
    expect(acknowledged.status).toBe(200);
    expect((await acknowledged.json() as Result).replayed).toBe(true);
    expect((await stack.accessPool.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM access.realm_submission WHERE contribution = $1`, [acknowledgementInput.contribution])).rows[0]!.count).toBe('1');

    const recoveryInput = await candidate();
    const recoveryOffer = await submit(recoveryInput);
    const recoveryKey = randomUUID();
    const record = stack.access.recordGraphOutcome.bind(stack.access);
    let loseResponse = true;
    stack.access.recordGraphOutcome = async (id, proof) => {
      if (loseResponse && proof.scope === `publication:adopt:${realm}`) {
        loseResponse = false;
        throw new SubmissionUnavailable('Injected lost adoption response');
      }
      return record(id, proof);
    };
    expect((await decide(recoveryOffer, decision(recoveryOffer), moderator, recoveryKey)).status).toBe(503);
    const committedSelection = await selected(recoveryInput);
    expect(committedSelection).toBeString();
    expect((await withdraw(recoveryOffer)).status).toBe(409);
    expect((await decide(recoveryOffer, decision(recoveryOffer, 'reject', moderator2), moderator2)).status).toBe(409);
    stack.access.recordGraphOutcome = record;
    await stack.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE recipient_subject = $1 AND action IN ('review.decide', 'publication.adopt')`, [moderator.actor]);
    app = makeApp();
    const recovered = await decide(recoveryOffer, decision(recoveryOffer), moderator, recoveryKey);
    expect({ status: recovered.status, body: await recovered.clone().json() }).toMatchObject({ status: 200 });
    expect(await recovered.json()).toMatchObject({ replayed: true,
      submission: { state: 'accepted', selection: committedSelection } });
    expect(await selected(recoveryInput)).toBe(committedSelection);
    expect((await read(moderator, `${root()}/${recoveryOffer.id}`)).status).toBe(404);

    await submit(await candidate());
    const queueFirst = await queue(moderator2, realm, '&limit=1');
    expect(queueFirst.status).toBe(200);
    const queueCursor = (await queueFirst.json() as Page<unknown>).nextCursor;
    expect(queueCursor).toBeString();
    expect((await queue(moderator2, realm, `&limit=1&cursor=${queueCursor}`)).status).toBe(200);
    const pendingMutation = await submit(await candidate());
    expect((await queue(moderator2, realm, `&cursor=${queueCursor}`)).status).toBe(409);
    expect((await withdraw(pendingMutation)).status).toBe(200);
    expect((await queue(moderator2, realm, '&limit=21')).status).toBe(400);

    const readSql = ownerSql;
    const readGraph = stack.fuseki.queries;
    const firstPage = await read(author, '/v1/my/submissions?limit=1');
    expect(ownerSql - readSql).toBeLessThanOrEqual(SUBMISSION_COST.readSqlStatements);
    expect(stack.fuseki.queries).toBe(readGraph);
    const page = await firstPage.json() as Page<SubmissionView>;
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeString();
    const nextPage = await read(author, `/v1/my/submissions?limit=1&cursor=${page.nextCursor}`);
    expect(nextPage.status).toBe(200);
    expect((await nextPage.json() as Page<SubmissionView>).items[0]!.id).not.toBe(page.items[0]!.id);
    expect((await read(author, `/v1/my/submissions?state=pending&cursor=${page.nextCursor}`)).status).toBe(400);
    await submit(await candidate());
    expect((await read(author, `/v1/my/submissions?cursor=${page.nextCursor}`)).status).toBe(409);
    const indexes = (await stack.accessPool.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes
      WHERE schemaname = 'access' AND tablename = 'realm_submission'`)).rows.map(row => row.indexname);
    expect(indexes).toContain('realm_submission_pending_page');
    expect(indexes).toContain('realm_submission_author_page');
    const revisionCount = (await stack.accessPool.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM access.realm_submission_revision WHERE submission_id = $1`, [recoveryOffer.id])).rows[0]!.count;
    expect(revisionCount).toBe('3');
  } finally { await stack.stop(); }
}, 60_000);
