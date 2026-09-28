import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { SUBMISSION_COST, SubmissionUnavailable, type SubmissionView } from '../../../services/main/src/modules/realm-submission/schema.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch } from '../../../services/main/src/modules/outbox/relay.ts';
import { authorProposalFixture, json, short } from './tag-proposal-support.ts';

interface Result { submission: SubmissionView; replayed: boolean }

test('G-354 submissions: whole Works and exact Content, review grants, following public chapters, CAS, withdrawal and recovery', async () => {
  const h = await authorProposalFixture();
  try {
    const work = await h.work();
    const realm = await h.realm();
    const reviewer = await h.agent();
    const otherWork = await h.work(reviewer);
    const root = `/v1/realms/${short(realm)}/submissions`;
    const input = { ...work, actingSubject: h.actor, kind: 'work' };
    const key = randomUUID();
    expect((await h.call('POST', root, { ...input, ...otherWork })).status).toBe(403);
    expect((await h.call('POST', root, { ...input, actingSubject: reviewer })).status).toBe(403);
    const opened = (await json<Result>(await h.call('POST', root, input, key))).submission;
    expect(opened).toMatchObject({ state: 'pending', contribution: null, selectedDraft: null, target: input });
    expect(await json(await h.call('POST', root, input, key), 200)).toMatchObject({ replayed: true, submission: { id: opened.id } });
    expect((await h.call('POST', root, { ...input, workRevision: reviewer }, key)).status).toBe(409);
    const decide = (row: SubmissionView, outcome = 'accept', decisionKey = randomUUID()) => h.call('POST',
      `${root}/${row.id}/decisions`, { actingSubject: reviewer, expectedRevision: row.revision,
        outcome, expectedSelectionHead: null, publicReason: outcome === 'accept' ? null : 'Needs revision',
        internalNote: 'Reviewer only' }, decisionKey);
    expect((await decide(opened)).status).toBe(403);
    await h.grant(reviewer, `review:decide:${realm}`, 'review.decide');
    expect((await decide(opened)).status).toBe(403); // Acceptance also requires adoption authority.
    await h.grant(reviewer, `publication:adopt:${realm}`, 'publication.adopt');
    const queue = await json<{ items: { id: string; kind: string }[] }>(await h.call('GET',
      `/v1/realms/${short(realm)}/moderation?actingSubject=${encodeURIComponent(reviewer)}&type=work_submission`), 200);
    expect(queue.items).toContainEqual(expect.objectContaining({ id: opened.id, kind: 'work_submission' }));
    const beforeAccept = h.graphCalls();
    const accepted = (await json<Result>(await decide(opened), 200)).submission;
    expect(h.graphCalls() - beforeAccept).toBeLessThanOrEqual(SUBMISSION_COST.commandGraphCalls);
    expect(accepted.state).toBe('accepted');
    expect(accepted.selection).toBeString();
    const receiptRow = (await h.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(accepted.adoptionReceipt!)} rv:sequence ?sequence } }`)).results!.bindings[0]!;
    const eventBatch = await readNextMainOutboxBatch(h.fuseki, h.env.lineage.dataEpoch,
      (BigInt(receiptRow.sequence!.value) - 1n).toString());
    expect(eventBatch?.eventIds).toHaveLength(1);
    const event = await readMainOutboxEnvelope(h.fuseki, eventBatch!, eventBatch!.eventIds[0]!);
    expect(event.type).toBe('com.rezics.realm.resource-selected.v1');
    expect(event.data.receipt).toMatchObject({ selection: accepted.selection, work: work.work, realm });
    expect((await decide(opened)).status).toBe(409);
    const publications = () => h.app.handle(new Request(`http://main.test/v1/realms/${short(realm)}/submitted-publications?work=${encodeURIComponent(work.work)}`));
    expect(await json(await publications(), 200)).toMatchObject({ items: [] });
    const child = await h.work();
    const structure = `https://rezics.com/id/${randomUUID()}`, generation = `https://rezics.com/id/${randomUUID()}`;
    const placement = `https://rezics.com/id/${randomUUID()}`;
    // Existing Structure owner fixture: the changed path publishes real Content
    // after the parent has already been accepted, without submitting a chapter.
    await h.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(structure)} a <${RV}Structure> ; <${RV}structureOf> ${iri(work.mainVersion)} ; <${RV}selectedGeneration> ${iri(generation)} .
      ${iri(placement)} a <${RV}OccurrencePlacement> ; <${RV}generation> ${iri(generation)} ;
        <${RV}occurrenceRole> <${RV}ChapterRole> ; <https://schema.org/item> ${iri(child.work)} . } }`);
    const content = await h.publish(child.work);
    await h.publish(child.work, false);
    expect(await json(await publications(), 200)).toMatchObject({ items: [{ resource: child.work,
      selection: accepted.selection, publicationDecision: content.publicationDecision,
      contentRevision: content.contentRevision }] });
    await h.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(placement)} <${RV}removedBy> ${iri(reviewer)} } }`);
    expect(await json(await publications(), 200)).toMatchObject({ items: [] });
    await h.fuseki.update(`DELETE DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(placement)} <${RV}removedBy> ${iri(reviewer)} } }`);

    const exact = { ...child, ...content, kind: 'content-publication', actingSubject: h.actor };
    const offeredContent = (await json<Result>(await h.call('POST', root, exact))).submission;
    const exactAccepted = (await json<Result>(await decide(offeredContent), 200)).submission;
    expect(exactAccepted.state).toBe('accepted');
    const exactPublications = () => h.app.handle(new Request(
      `http://main.test/v1/realms/${short(realm)}/submitted-publications?work=${encodeURIComponent(child.work)}`));
    expect(await json(await exactPublications(), 200)).toMatchObject({ items: [{ kind: 'content-publication',
      selection: exactAccepted.selection, ...content }] });
    const unpublished = await h.publish(child.work, false);
    expect((await h.call('POST', root, { ...exact, ...unpublished })).status).toBe(404);
    await h.fuseki.update(`DELETE WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(content.variant)} <${RV}publicSearchEligibilityHead> ?eligibility } }`);
    expect(await json(await exactPublications(), 200)).toMatchObject({ items: [] });
    const staleWork = await h.work();
    const stale = (await json<Result>(await h.call('POST', root, { ...input, ...staleWork }))).submission;
    await h.fuseki.update(`DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(staleWork.work)} <${RV}head> ?head } }
      INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(staleWork.work)} <${RV}head> ${iri(reviewer)} } }
      WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(staleWork.work)} <${RV}head> ?head } }`);
    expect((await json<Result>(await decide(stale), 200)).submission.state).toBe('stale');

    const withdrawWork = await h.work();
    const withdrawn = (await json<Result>(await h.call('POST', root, { ...input, ...withdrawWork }))).submission;
    expect((await h.call('POST', `${root}/${withdrawn.id}/withdrawals`, { actingSubject: reviewer,
      expectedRevision: withdrawn.revision })).status).toBe(403);
    expect((await json<Result>(await h.call('POST', `${root}/${withdrawn.id}/withdrawals`, { actingSubject: h.actor,
      expectedRevision: withdrawn.revision }), 200)).submission.state).toBe('withdrawn');
    expect((await decide(withdrawn)).status).toBe(409);

    for (const [outcome, state] of [['reject', 'rejected'], ['request-changes', 'changes-requested']] as const) {
      const offered = (await json<Result>(await h.call('POST', root, { ...input, ...await h.work() }))).submission;
      const decisionKey = randomUUID();
      expect((await json<Result>(await decide(offered, outcome, decisionKey), 200)).submission.state).toBe(state);
      expect(await json(await decide(offered, outcome, decisionKey), 200)).toMatchObject({ replayed: true });
      if (state === 'changes-requested') {
        const current = (await json<Result>(await decide(offered, outcome, decisionKey), 200)).submission;
        expect((await json<Result>(await h.call('POST', `${root}/${offered.id}/withdrawals`, {
          actingSubject: h.actor, expectedRevision: current.revision }), 200)).submission.state).toBe('withdrawn');
      }
    }
    const contestedWork = await h.work();
    const contenders = await Promise.all([0, 1].map(async () =>
      (await json<Result>(await h.call('POST', root, { ...input, ...contestedWork }))).submission));
    const race = await Promise.all(contenders.map(async contender => {
      const decisionKey = randomUUID();
      let response = await decide(contender, 'accept', decisionKey);
      // A guard race may first report an ambiguous command; retry its receipt key.
      if (response.status === 503) response = await decide(contender, 'accept', decisionKey);
      return (await json<Result>(response, 200)).submission.state;
    }));
    expect(race.sort()).toEqual(['accepted', 'stale']);

    const recoveryWork = await h.work();
    const recovery = (await json<Result>(await h.call('POST', root, { ...input, ...recoveryWork }))).submission;
    const recoveryKey = randomUUID();
    const original = h.access.recordGraphOutcome.bind(h.access);
    let lost = false;
    h.access.recordGraphOutcome = async (id, proof) => {
      if (!lost && proof.scope === `publication:adopt:${realm}`) { lost = true; throw new SubmissionUnavailable('lost response'); }
      return original(id, proof);
    };
    expect((await decide(recovery, 'accept', recoveryKey)).status).toBe(503);
    h.access.recordGraphOutcome = original;
    await h.accessPool.query("UPDATE access.permission_grant SET active = false WHERE recipient_subject = $1 AND action = 'publication.adopt'", [reviewer]);
    expect(await json(await decide(recovery, 'accept', recoveryKey), 200)).toMatchObject({
      replayed: true, submission: { state: 'accepted' } });
    const snapshots = await h.accessPool.query('SELECT generation FROM access.realm_submission_revision WHERE submission_id = $1', [recovery.id]);
    expect(snapshots.rows).toHaveLength(3);

    const settingsRoot = `/v1/realms/${short(realm)}/settings`;
    for (const action of ['realm.settings.manage', 'governance.rule.publish']) {
      await h.grant(h.actor, `governance:realm:${realm}`, action);
    }
    const settings = await json<{ generation: string; ruleBasis: { revision: string | null } }>(
      await h.call('GET', `${settingsRoot}?actingSubject=${encodeURIComponent(h.actor)}`), 200);
    await json(await h.call('PUT', settingsRoot, { actingSubject: h.actor,
      expectedGeneration: settings.generation, expectedRulesRevision: settings.ruleBasis.revision,
      reason: 'Allow direct public submissions', settings: { visibility: 'public', reviewRequired: false,
        reviewMode: 'open', whoMaySubmit: 'granted', rules: [] } }));
    const direct = await h.work();
    expect((await json<Result>(await h.call('POST', root, { ...input, ...direct }))).submission.state).toBe('accepted');
    const privacy = JSON.stringify(await json(await h.call('GET', `/v1/my/submissions?actingSubject=${encodeURIComponent(h.actor)}`), 200));
    expect(privacy).not.toContain('Reviewer only');
  } finally { await h.close(); }
}, 120_000);
