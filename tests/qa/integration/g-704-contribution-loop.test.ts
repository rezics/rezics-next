import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { submitWikiBundle } from '../../../packages/wiki-toolkit/src/submit.ts';
import type { WikiDelta } from '../../../services/main/src/modules/wiki/delta.ts';
import type { WikiExtraction } from '../../../services/main/src/modules/wiki/protocol.ts';
import { RV } from '../../../services/main/src/modules/work/activate.ts';
import { type Command, type History, type Loop, loopStack, type Member, type ProposalRead, short, wikiWorld, type WikiWorld } from './g-704-support.ts';

/** The language of a Swedish catalogue Work: none of the eight interface locales, so nothing may borrow the UI's. */
const SV = 'sv';

test('CLP01: a correction in a non-UI language is proposed, reviewed, revised, decided, notified, withdrawn and reverted', async () => {
  const L = await loopStack('g-704-catalogue');
  const { holder, steward, second, call, json, read, review, decide, revise, withdraw, revert, inbox, header, correction } = L;
  try {
    const work = await L.catalogueWork('Sagan om ringen', SV);
    const base = (description: string) => header('Sagan om ringen', SV, description);

    // Propose: the contributor holds no review authority, so the correction waits for an independent reviewer.
    const created = await correction(work, holder, base('Första beskrivningen'));
    const first = await read(created.proposal, holder);
    expect(first.state).toBe('open');
    expect(first.allowedActions).toEqual(expect.arrayContaining(['revise', 'withdraw']));
    expect(first.allowedActions).not.toContain('apply');
    expect(first.blockers.map((b) => b.code)).toContain('self_review');
    expect(await L.blocker(await review(created.proposal, 1, 'approve', holder), 403)).toBe('self_review');
    expect(await L.blocker(await decide(created.proposal, 1, holder), 403)).toBe('self_review');

    // Notify: reviewers with authority hear about it, the author does not hear about their own request.
    const stewardInbox = await inbox(steward);
    const requested = stewardInbox.items.find((item) => item.proposal?.id === created.proposal);
    expect(requested).toMatchObject({ topic: 'review-requested', reason: 'steward' });
    expect((await inbox(holder)).items.filter((item) => item.proposal?.id === created.proposal)).toEqual([]);

    // Review: a stance the contributor must answer.
    await json(await review(created.proposal, 1, 'request_changes', steward, 'Cite the edition'));
    expect((await read(created.proposal, holder)).state).toBe('changes_requested');
    const changes = (await inbox(holder)).items.find((item) => item.topic === 'changes-requested');
    expect(changes).toMatchObject({ reason: 'author', proposal: { id: created.proposal, revision: 1 } });

    // Revise: the stance belonged to revision 1, so revision 2 starts clean and the reviewers are told.
    await json(await revise(created.proposal, 1, { command: 'work-metadata', state: base('Andra beskrivningen') },
      [{ component: (first.revision.baseHeads[0]!).component, head: null }], holder));
    const second2 = await read(created.proposal, steward);
    expect(second2.revision.n).toBe(2);
    expect(second2.state).toBe('open');
    expect((await inbox(steward)).items.some((item) => item.topic === 'proposal-revised' && item.proposal?.revision === 2)).toBe(true);

    // A second reviewer approves revision 2 ...
    await json(await review(created.proposal, 2, 'approve', second, 'Verified against the print'));
    const approved = await read(created.proposal, steward);
    expect(approved.state).toBe('approved');
    expect(approved.approvalIds).toHaveLength(1);
    expect(approved.allowedActions).toContain('apply');

    // ... and a changed candidate invalidates that approval. It stays visible as stale, but counts for nothing.
    await json(await revise(created.proposal, 2, { command: 'work-metadata', state: base('Tredje beskrivningen') },
      approved.revision.baseHeads, holder));
    const stale: ProposalRead = await read(created.proposal, steward);
    expect(stale.approvalIds).toEqual([]);
    expect(stale.staleApprovalIds).toHaveLength(1);
    expect(stale.state).toBe('open');
    expect(stale.allowedActions).not.toContain('apply');
    expect(stale.allowedActions).toContain('approve-and-apply');
    expect(await L.blocker(await decide(created.proposal, 3, steward, false), 409)).toBe('required_approvals');
    expect(await L.blocker(await decide(created.proposal, 2, steward), 409)).toBe('stale_revision');

    // Decide: the steward's own approval on the exact revision applies it, once, and a replay is the same effect.
    const key = crypto.randomUUID();
    const applied = await json<{ receipt?: unknown; replayed?: boolean }>(await decide(created.proposal, 3, steward, true, key));
    expect(applied.receipt).toBeDefined();
    const replay = await json<{ receipt?: unknown; replayed?: boolean }>(await decide(created.proposal, 3, steward, true, key));
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(applied.receipt);
    expect(L.faults.headerWrites).toBe(1);
    const metadata = async () => json<{ revision: string; localized: { language: string; description: string }[] }>(
      await call('GET', `/v1/works/${work.work.slice(-36)}/metadata`, undefined, holder.token));
    expect((await metadata()).localized).toEqual([expect.objectContaining({ language: SV, description: 'Tredje beskrivningen' })]);
    const decided = (await inbox(holder)).items.find((item) => item.topic === 'proposal-decided');
    expect(decided).toMatchObject({ reason: 'author', proposal: { id: created.proposal, revision: 3 } });

    // Notify: inbox triage is per recipient and survives later events.
    const item = decided!;
    await json(await call('PUT', `/v1/me/notifications/${item.id}/triage`,
      { profile: 'notification-item-triage-v1', done: true, saved: true, expectedRevision: null }, holder.token));
    expect((await inbox(holder)).items.some((row) => row.id === item.id)).toBe(false);
    expect((await inbox(holder, '?view=saved')).items.some((row) => row.id === item.id)).toBe(true);
    expect((await inbox(steward)).items.some((row) => row.id === item.id)).toBe(false);

    // Recover: an applied correction is undone by a reviewed reversal that names it, and the original stays on record.
    const reversal = await revert(created.proposal);
    expect((await read(reversal.proposal, steward)).proposal.reverts).toBe(created.proposal);
    expect((await inbox(steward)).items.some((row) => row.proposal?.id === reversal.proposal)).toBe(true);
    await json(await decide(reversal.proposal, 1, steward));
    expect((await inbox(holder)).items.some((row) => row.topic === 'proposal-reverted' && row.proposal?.id === reversal.proposal)).toBe(true);
    expect((await read(created.proposal, steward)).state).toBe('applied');

    // Recover: a lost owner response leaves a durable pending intent; recovery reports the committed receipt.
    const lostBase = [{ component: first.revision.baseHeads[0]!.component, head: (await metadata()).revision }];
    const lost = await json<{ proposal: string }>(await call('POST', '/v1/editorial/proposals', {
      profile: 'editorial-proposal-create-v1', kind: 'component-correction',
      target: { resource: work.work, revision: await L.head(work.work), context: 'urn:rezics:context:global' },
      candidate: { command: 'work-metadata', state: base('Förlorat svar') }, baseHeads: lostBase, evidence: [],
      actingSubject: holder.actor,
    }, holder.token), 201);
    L.faults.loseHeaderResponse = true;
    expect((await json<{ outcome: string }>(await decide(lost.proposal, 1, steward), 202)).outcome).toBe('apply_pending');
    expect((await read(lost.proposal, steward)).allowedActions).toEqual(['recover']);
    L.faults.hideReceipts = false;
    const recovered = await json<ProposalRead>(await call('POST', L.path(lost.proposal, '/recovery'),
      { profile: 'editorial-proposal-recover-v1', actingSubject: steward.actor }, steward.token));
    expect(recovered.state).toBe('applied');
    expect((await metadata()).localized[0]?.description).toBe('Förlorat svar');

    // Recover: a withdrawn proposal is closed for everyone.
    const stray = await correction(work, holder, base('Ska dras tillbaka'), (await metadata()).revision);
    await json(await withdraw(stray.proposal, 1, holder));
    expect((await read(stray.proposal, steward)).state).toBe('withdrawn');
    expect(await L.blocker(await decide(stray.proposal, 1, steward), 409)).toBe('terminal_decision');
  } finally {
    await L.close();
  }
}, 300_000);

const GLOBAL = 'urn:rezics:context:global';

/** The wiki toolkit's own submit call, sent over Main's app as the given credential. */
async function submit(L: Loop, world: WikiWorld, who: Member, candidate: unknown,
  baseHeads: { component: string; head: string | null }[], revision: string): Promise<Command> {
  const response = await submitWikiBundle({
    send: async (envelope) => {
      const delivered = await L.call(envelope.method, envelope.path, envelope.body, who.token, envelope.headers['idempotency-key']);
      return { status: delivered.status, body: (await delivered.json()) as unknown };
    },
  }, { target: { resource: world.work.work, revision, context: GLOBAL }, bundle: candidate, baseHeads, evidence: [],
    actingSubject: who.actor }, `Bearer ${who.token}`, randomUUID());
  if (response.status !== 201) throw new Error(`Wiki toolkit submission failed: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body as Command;
}

const historyPath = (world: WikiWorld) => `/v1/wiki/${short(world.work.work)}/history?position=all`;
const history = async (L: Loop, world: WikiWorld, who: Member | null = L.holder, query = '') =>
  L.json<History>(await L.call('GET', historyPath(world) + query, undefined, who?.token ?? null));
const outcome = (receipt: NonNullable<Command['receipt']>, suffix: string) =>
  (receipt.commands!.find((row) => row.key.endsWith(`:${suffix}`))!.result as { component: string; revision: string });

/** The assistant proposes the first bundle; the steward applies it. */
async function appliedBundle(L: Loop, world: WikiWorld) {
  const head = await L.head(world.work.work);
  const proposal = await submit(L, world, L.assistant, world.bundle, [{ component: world.work.work, head }], head);
  const receipt = await L.apply(proposal.proposal, 1);
  return { proposal, receipt };
}

test('CLP02: an assistant proposes a wiki bundle, reviewers revise and decide it, and everyone concerned is notified', async () => {
  const L = await loopStack('g-704-bundle');
  const { steward, second, assistant, holder, json, read, review, revise } = L;
  try {
    const world = await wikiWorld(L);
    const head = await L.head(world.work.work);
    const baseHeads = [{ component: world.work.work, head }];
    const created = await submit(L, world, assistant, world.bundle, baseHeads, head);
    // Nothing is published by proposing: the public wiki stays empty until a reviewer decides.
    expect((await history(L, world)).claims).toEqual([]);
    const first = await read(created.proposal, assistant);
    expect(first.state).toBe('open');
    expect(first.allowedActions).not.toContain('apply');
    expect(first.blockers.map((b) => b.code)).toContain('self_review');
    // The assistant's operator maintains the Work, yet is dependent on the assistant and cannot review what it made.
    expect(await L.blocker(await review(created.proposal, 1, 'approve', holder), 403)).toBe('self_review');
    expect(await L.blocker(await L.decide(created.proposal, 1, assistant), 403)).toBe('self_review');
    expect((await L.inbox(steward)).items.find((item) => item.proposal?.id === created.proposal))
      .toMatchObject({ topic: 'review-requested', reason: 'steward' });

    await json(await review(created.proposal, 1, 'request_changes', second, 'Chapter three is not cited'));
    expect((await L.inbox(assistant)).items.find((item) => item.topic === 'changes-requested'))
      .toMatchObject({ reason: 'author', proposal: { id: created.proposal, revision: 1 } });
    // A revised bundle starts review again, and tells the reviewer who asked for changes.
    const improved: WikiExtraction = { ...world.bundle, claims: [world.bundle.claims[0]!] };
    await json(await revise(created.proposal, 1, improved, baseHeads, assistant));
    expect((await L.inbox(second)).items.some((item) => item.topic === 'proposal-revised' && item.proposal?.revision === 2)).toBe(true);
    await json(await review(created.proposal, 2, 'approve', second, 'Cited'));
    expect((await read(created.proposal, steward)).approvalIds).toHaveLength(1);
    // The reviewed candidate changes after that approval: the approval no longer counts.
    await json(await revise(created.proposal, 2, world.bundle, baseHeads, assistant));
    const stale = await read(created.proposal, steward);
    expect(stale.approvalIds).toEqual([]);
    expect(stale.staleApprovalIds).toHaveLength(1);
    expect(stale.allowedActions).not.toContain('apply');
    expect(await L.blocker(await L.decide(created.proposal, 3, steward, false), 409)).toBe('required_approvals');

    const receipt = await L.apply(created.proposal, 3);
    expect(receipt.candidate).toEqual(expect.objectContaining({ profile: 'wiki-extraction-v1' }));
    const applied = await history(L, world);
    expect(applied.claims).toHaveLength(2);
    expect(applied.entities.map((entity) => entity.entity)).toHaveLength(2);
    expect((await L.inbox(assistant)).items.find((item) => item.topic === 'proposal-decided'))
      .toMatchObject({ proposal: { id: created.proposal, revision: 3 } });
    expect((await read(created.proposal, null)).state).toBe('applied');
  } finally {
    await L.close();
  }
}, 300_000);

test('CLP03: a chapter delta retracts one claim without deleting what it omits, resumes after interruption and reverts', async () => {
  const L = await loopStack('g-704-delta');
  const { steward, assistant, json, read, revise } = L;
  try {
    const world = await wikiWorld(L);
    const { receipt } = await appliedBundle(L, world);
    const elizabeth = outcome(receipt, 'entity:elizabeth').component;
    const statement = outcome(receipt, 'claim:0');
    const pinned = await history(L, world);
    expect(pinned.claims).toHaveLength(2);
    // Chapter four omits Jane and the relation entirely; omission is silence, not deletion.
    const fourth = world.chapters.occurrences[3]!;
    const chapter = (quote: string): WikiExtraction => ({
      ...world.bundle, entities: [],
      units: [{ ...world.bundle.units[0]!, id: 'ch4', ordinal: 3, label: 'Chapter 4', occurrence: fourth }],
      claims: [{ ...world.bundle.claims[0]!, subject: elizabeth, revealedAt: 'ch4',
        evidence: [world.evidenceFor(quote)] }],
    });
    const delta = (bundle: WikiExtraction, changes: WikiDelta['changes'], base = pinned.revisions): WikiDelta =>
      ({ profile: 'wiki-delta-v1', base, bundle, changes });
    const retract: WikiDelta['changes'] = [{ claim: statement.component, revision: statement.revision, operation: 'retract',
      reason: 'Chapter four contradicts this assertion', evidenceClaim: 0 }];
    const submitDelta = (candidate: WikiDelta) => submit(L, world, assistant, candidate, receipt.afterHeads, receipt.afterHeads[0]!.head!);
    const created = await submitDelta(delta(chapter('Chapter four corrects the family'), retract));
    const contender = await submitDelta(delta(chapter('Chapter four corrects the family'), retract));
    expect((await history(L, world)).claims).toEqual(pinned.claims);
    expect(await L.blocker(await L.decide(created.proposal, 1, steward, false), 409)).toBe('required_approvals');

    // The evidence owner is interrupted before it commits: the decision is pending, then resumes with the same key.
    L.faults.pausePublication = created.proposal;
    const key = randomUUID();
    await json(await L.decide(created.proposal, 1, steward, true, key), 202);
    const ended = await L.apply(created.proposal, 1, steward, key);
    expect(await L.apply(created.proposal, 1, steward, key)).toEqual(ended);
    expect(ended.commands!.find((row) => row.key.endsWith(':delta-end:0'))?.outcome).toBe('applied');
    // A competing delta against the same base cannot also apply.
    expect((await L.decide(contender.proposal, 1, steward)).status).toBe(409);
    const current = await history(L, world);
    expect(current.claims.map((claim) => claim.claim)).toEqual([pinned.claims[1]!.claim]);
    expect(current.entities).toHaveLength(2);

    // A changed delta invalidates its approval too.
    const other = await submitDelta(delta(chapter('Chapter four again'), [], current.revisions));
    await json(await L.review(other.proposal, 1, 'approve', L.second));
    await json(await revise(other.proposal, 1, delta(chapter('Chapter four, revised'), [], current.revisions), receipt.afterHeads, assistant));
    const stale: ProposalRead = await read(other.proposal, steward);
    expect(stale.approvalIds).toEqual([]);
    expect(stale.staleApprovalIds).toHaveLength(1);

    // Revert restores what the delta ended, from the retained receipt.
    const reversal = await L.revert(created.proposal, assistant);
    const restored = await L.apply(reversal.proposal, 1);
    expect(restored.commands!.find((row) => row.key.endsWith(':delta-restore:0'))?.outcome).toBe('applied');
    expect((await history(L, world)).claims.map((claim) => claim.value.object))
      .toEqual([pinned.claims[1]!.value.object, pinned.claims[0]!.value.object]);
    expect(RV).toBeDefined();
  } finally {
    await L.close();
  }
}, 300_000);
