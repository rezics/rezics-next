import { entries as related0 } from './governance-reports.entries.ts';
import { randomUUID } from 'node:crypto';
import { expect } from 'bun:test';
import { AdmissionConflict, AdmissionDenied } from '../../src/modules/access/admission.ts';
import { deactivateFixtureController, expireFixtureAuthority, grantFixtureAuthority, reduceFixtureGrant }
  from '../../src/modules/access/fixture-authority.ts';
import { GovernanceConflict, GovernanceDenied, GLOBAL_CONTEXT, DECIDE_ACTION, APPEAL_ACTION,
  type DecisionInput, type ReportInput, type StepInput } from '../../src/modules/governance/store.ts';
import { GovernanceRules, RULE_PUBLISH_ACTION } from '../../src/modules/governance/rules.ts';
import { createAdmittedMetadataWork } from '../../src/modules/work/create-admitted.ts';
import { saveAdmittedContentDraft } from '../../src/modules/content-publication/draft.ts';
import { changeWorkProtection, proposeWorkCorrection, reviewWorkCorrection, readWorkCorrectionProposal,
  readWorkEditorialState, type WorkEditorialBasis, type WorkProtectionReceipt } from '../../src/modules/protection/work.ts';
import { changeAdmittedProtection, proposeAdmittedCorrection, decideAdmittedCorrection,
  type ProtectionCommand } from '../../src/modules/protection/admitted.ts';
import { PROTECTION_RULE, type ProtectionAction } from '../../src/modules/protection/schema.ts';
import { ASSESS_ACTION, ASSESS_SCOPE, type AssessmentInput } from '../../src/modules/rights/store.ts';
import { RightsConflict, RightsDenied } from '../../src/modules/rights/store.ts';
import { requestContentErasure } from '../../src/modules/erasure/request.ts';
import { readErasure } from '../../src/modules/erasure/journal.ts';
import { type ReplayEntry, type Member, type Loss, stack, principal, request, loseGrant, proposal } from './fixtures.ts';

type AuthorityClass = ReplayEntry['authorityClass'];
const authorityClasses: AuthorityClass[] = ['domain-grant', 'controller'];
// Current controller episodes are open-ended. Finite grants exercise expiry;
// controller loss revokes one episode while preserving a second controller.
const losses = (authorityClass: AuthorityClass): Loss[] => authorityClass === 'controller'
  ? ['revoked'] : ['expired', 'revoked'];

async function authority(member: Member, scope: string, action: string, authorityClass: AuthorityClass) {
  if (authorityClass === 'domain-grant') {
    const grant = await member.grant(scope, action);
    return async (loss: Loss) => {
      if (loss === 'revoked') await reduceFixtureGrant(stack.accessPool, grant, { active: false });
      else {
        const clock = (await stack.accessPool.query<{ deadline: Date }>(
          "SELECT clock_timestamp() - interval '1 second' AS deadline")).rows[0]!.deadline;
        await reduceFixtureGrant(stack.accessPool, grant, { validUntil: clock });
      }
    };
  }
  // End setup mandates so an action-specific mandate cannot mask control loss.
  await expireFixtureAuthority(stack.accessPool, member.actor);
  const spare = await stack.member(randomUUID());
  const proof = await grantFixtureAuthority(stack.accessPool, { scope, requireDispatch: true,
    representations: [member, spare].map(controller => ({ principalId: controller.principalId,
      actor: member.actor, action: 'agent.control', lifetime: 'infinity' as const })),
    grant: { actor: member.actor, action, lifetime: 'infinity' } });
  return async () => deactivateFixtureController(stack.accessPool, proof.representationIds[0]!);
}

const admissions = async (member: Member) => (await stack.accessPool.query(`SELECT to_jsonb(a) AS row
  FROM access.admission a WHERE principal_id = $1 ORDER BY id`, [member.principalId])).rows;

async function workFixture() {
  const author = await stack.member(randomUUID());
  await author.grant('work:create:root', 'work.create');
  const created = await createAdmittedMetadataWork(stack.env, stack.composition.dependencies.account,
    stack.access, request(author), { actingSubject: author.actor, authorAgent: author.actor,
      title: 'Retained original title', language: 'en', idempotencyKey: randomUUID() });
  for (const action of ['tighten', 'confirm', 'relax']) {
    await author.grant(`work:protect:${created.work}`, `work.protection.${action}`);
    await author.grant(`content:protect:${created.work}`, `content.protection.${action}`);
  }
  await author.grant(`work:correct:${created.work}`, 'work.correction.propose');
  await author.grant(`content:correct:${created.work}`, 'content.correction.propose');
  return { author, created };
}

async function workSnapshot(work: string, receipt: string, member: Member) {
  const graph = (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?g ?s ?p ?o WHERE {
      VALUES ?g { <urn:rezics:graph:current> <urn:rezics:graph:revisions> <urn:rezics:graph:receipts> }
      GRAPH ?g { ?s ?p ?o }
      FILTER(?s = <${work}> || ?s = <${receipt}> || EXISTS {
        GRAPH <urn:rezics:graph:revisions> { ?s rv:component <${work}> }
      })
    } ORDER BY ?g ?s ?p ?o LIMIT 2048`)).results?.bindings ?? [];
  expect(graph.length).toBeLessThan(2048);
  return { graph, admissions: await admissions(member) };
}

async function contentFixture() {
  const { author, created } = await workFixture();
  await author.grant(`content:draft:${created.work}`, 'content.draft');
  const variant = { id: `urn:rezics:variant:${randomUUID()}`, resourceId: created.work,
    language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' }, direction: 'ltr' as const };
  const draft = await saveAdmittedContentDraft(stack.env, stack.content, stack.composition.dependencies.account,
    stack.access, request(author), { resourceId: created.work, variant, expectedHead: null,
      body: 'Retained original Content', actingSubject: author.actor, idempotencyKey: randomUUID() });
  expect(draft.outcome).toBe('succeeded');
  return { author, created, variant, draft };
}

async function contentSnapshot(resource: string, member: Member) {
  const rows = (await stack.contentPool.query(`SELECT to_jsonb(v) AS variant,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM content.revision r WHERE r.variant_id = v.id) AS revisions,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY operation_id) FROM content.receipt r WHERE r.variant_id = v.id) AS receipts,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM content.protection_revision p WHERE p.variant_id = v.id) AS protections,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM content.correction_proposal p WHERE p.variant_id = v.id) AS proposals,
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM content.correction_decision d WHERE d.variant_id = v.id) AS decisions,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY decision_id) FROM content.correction_application a WHERE a.variant_id = v.id) AS applications
    FROM content.variant v WHERE resource_id = $1 ORDER BY id`, [resource])).rows;
  return { content: rows, admissions: await admissions(member) };
}

function workEntry(kind: 'protection' | 'proposal' | 'decision', authorityClass: AuthorityClass): ReplayEntry {
  const action = kind === 'protection' ? 'work.protection.{action}'
    : kind === 'proposal' ? 'work.correction.propose' : 'work.correction.review';
  return { operation: kind === 'protection' ? 'POST /v1/work-title-protections'
    : kind === 'proposal' ? 'POST /v1/work-title-corrections' : 'POST /v1/work-title-corrections/{}/decisions',
  authorityClass, losses: losses(authorityClass), scope: `work:${kind === 'protection' ? 'protect' : kind === 'proposal' ? 'correct' : 'review'}:{work}`,
  action, family: `Work title ${kind} ${authorityClass}`,
  owners: [`modules/protection/work.ts#${kind === 'protection' ? 'changeWorkProtection'
    : kind === 'proposal' ? 'proposeWorkCorrection' : 'reviewWorkCorrection'}`],
  subcases: kind === 'protection' ? ['tighten', 'confirm', 'relax'] : kind === 'proposal' ? ['candidate'] : ['approved', 'rejected'],
  denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'turned',
  requestBuilder: async subcase => {
    const { author, created } = await workFixture();
    const member = await stack.member(randomUUID());
    const deps = stack.composition.dependencies;
    const signer = deps.protectionSigner!;
    let basis: WorkEditorialBasis = { work: created.work, actingSubject: author.actor,
      expectedHead: created.workRevision, expectedProtection: null, expectedControl: null,
      expectedControlEpoch: '0', expectedRuleRevision: PROTECTION_RULE, reason: 'Retain exact reviewed basis',
      evidence: [], idempotencyKey: randomUUID() };
    if (kind !== 'protection' || subcase === 'relax') {
      const tightened = await changeWorkProtection(stack.env, deps.account, stack.access, signer,
        request(author), { ...basis, action: 'tighten' });
      expect(tightened.outcome).toBe('succeeded');
      basis = { ...basis, expectedProtection: tightened.protectionRevision!, idempotencyKey: randomUUID() };
    }
    let proposed: NonNullable<Awaited<ReturnType<typeof readWorkCorrectionProposal>>> | undefined;
    if (kind === 'decision') {
      const result = await proposeWorkCorrection(stack.env, deps.account, stack.access, signer,
        request(author), { ...basis, title: 'Independent candidate', predecessor: null });
      expect(result.outcome).toBe('succeeded');
      proposed = (await readWorkCorrectionProposal(stack.env, result.proposalRevision!))!;
    }
    const actualAction = kind === 'protection' ? `work.protection.${subcase}` : action;
    const scope = `work:${kind === 'protection' ? 'protect' : kind === 'proposal' ? 'correct' : 'review'}:${created.work}`;
    const lose = await authority(member, scope, actualAction, authorityClass);
    const input = { ...basis, actingSubject: member.actor, idempotencyKey: randomUUID() };
    let saved: WorkProtectionReceipt;
    return { command: async (fresh, changed) => {
      const common = { ...input, ...(fresh ? { idempotencyKey: randomUUID() } : {}),
        ...(changed ? { reason: 'Different binding' } : {}) };
      const result = kind === 'protection'
        ? await changeWorkProtection(stack.env, deps.account, stack.access, signer, request(member),
          { ...common, action: subcase as ProtectionAction })
        : kind === 'proposal'
          ? await proposeWorkCorrection(stack.env, deps.account, stack.access, signer, request(member),
            { ...common, title: 'Retained candidate', predecessor: null })
          : await reviewWorkCorrection(stack.env, deps.account, stack.access, signer, request(member),
            { ...common, proposalRevision: proposed!.proposal, candidateDigest: proposed!.candidateDigest,
              expectedDecisionHead: null, outcome: subcase as 'approved' | 'rejected' });
      expect(result.outcome).toBe('succeeded');
      saved ??= result;
      return result;
    }, lose, advance: async () => {
      const state = (await readWorkEditorialState(stack.env, created.work))!;
      const next = await changeWorkProtection(stack.env, deps.account, stack.access, signer, request(author),
        { ...basis, expectedHead: state.contentHead, expectedProtection: state.protectionHead,
          expectedControl: state.controlHead, expectedControlEpoch: state.controlEpoch,
          action: state.protectionMode === 'review-required' ? 'relax' : 'tighten', idempotencyKey: randomUUID() });
      expect(next.outcome).toBe('succeeded');
      expect(next.protectionRevision).not.toBe(state.protectionHead);
    }, snapshot: () => workSnapshot(created.work, saved.receipt, member) };
  } };
}

function contentEntry(kind: 'protection' | 'proposal' | 'decision', authorityClass: AuthorityClass): ReplayEntry {
  const action = kind === 'protection' ? 'content.protection.{action}'
    : kind === 'proposal' ? 'content.correction.propose' : 'content.correction.review';
  return { operation: kind === 'protection' ? 'POST /v1/editorial-protections'
    : kind === 'proposal' ? 'POST /v1/corrections' : 'POST /v1/corrections/{}/decisions',
  authorityClass, losses: losses(authorityClass), scope: `content:${kind === 'protection' ? 'protect' : kind === 'proposal' ? 'correct' : 'review'}:{work}`,
  action, family: `Content ${kind} ${authorityClass}`,
  owners: [`modules/protection/admitted.ts#${kind === 'protection' ? 'changeAdmittedProtection'
    : kind === 'proposal' ? 'proposeAdmittedCorrection' : 'decideAdmittedCorrection'}`],
  subcases: kind === 'protection' ? ['tighten', 'confirm', 'relax'] : kind === 'proposal' ? ['candidate'] : ['approved', 'rejected'],
  denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'turned',
  requestBuilder: async subcase => {
    const { author, created, variant, draft } = await contentFixture();
    const member = await stack.member(randomUUID());
    const deps = stack.composition.dependencies;
    const store = deps.editorialProtection!;
    let basis: ProtectionCommand = { resourceId: created.work, variantId: variant.id, actingSubject: author.actor,
      expectedContentHead: draft.revisionId!, expectedProtectionHead: null, expectedRuleRevision: PROTECTION_RULE,
      reason: 'Retain exact Content basis', evidence: [], idempotencyKey: randomUUID(), action: 'tighten' };
    if (kind !== 'protection' || subcase === 'relax') {
      const tightened = await changeAdmittedProtection(store, deps.account, stack.access, request(author), basis);
      expect(tightened.outcome).toBe('succeeded');
      basis = { ...basis, expectedProtectionHead: tightened.value!.id, idempotencyKey: randomUUID() };
    }
    let proposed: NonNullable<Awaited<ReturnType<typeof store.readCorrection>>> | undefined;
    if (kind === 'decision') {
      const result = await proposeAdmittedCorrection(store, deps.account, stack.access, request(author),
        { ...basis, body: 'Independent Content candidate', predecessor: null });
      expect(result.outcome).toBe('succeeded');
      proposed = (await store.readCorrection(result.value!.proposalRevision))!;
    }
    const actualAction = kind === 'protection' ? `content.protection.${subcase}` : action;
    const scope = `content:${kind === 'protection' ? 'protect' : kind === 'proposal' ? 'correct' : 'review'}:${created.work}`;
    const lose = await authority(member, scope, actualAction, authorityClass);
    const input = { ...basis, actingSubject: member.actor, idempotencyKey: randomUUID() };
    return { command: async (fresh, changed) => {
      const common = { ...input, ...(fresh ? { idempotencyKey: randomUUID() } : {}),
        ...(changed ? { reason: 'Different Content binding' } : {}) };
      const result = kind === 'protection'
        ? await changeAdmittedProtection(store, deps.account, stack.access, request(member),
          { ...common, action: subcase as ProtectionAction })
        : kind === 'proposal'
          ? await proposeAdmittedCorrection(store, deps.account, stack.access, request(member),
            { ...common, body: 'Retained Content candidate', predecessor: null })
          : await decideAdmittedCorrection(store, deps.account, stack.access, request(member),
            { ...common, proposalRevision: proposed!.proposal.proposalRevision,
              expectedCandidateDigest: proposed!.proposal.candidateDigest, outcome: subcase as 'approved' | 'rejected' });
      expect(result.outcome).toBe('succeeded');
      return result;
    }, lose, advance: async () => {
      const state = (await store.editorialStates([variant.id]))[0]!;
      const next = await changeAdmittedProtection(store, deps.account, stack.access, request(author),
        { ...basis, expectedContentHead: state.contentHead!, expectedProtectionHead: state.protection?.id ?? null,
          action: 'confirm', idempotencyKey: randomUUID() });
      expect(next.outcome).toBe('succeeded');
      expect(next.value!.id).not.toBe(state.protection?.id);
    }, snapshot: () => contentSnapshot(created.work, member) };
  } };
}

async function decisionFixture(kind: 'content_report' | 'rights_complaint') {
  const reporter = await stack.member(randomUUID());
  const staff = await stack.member(randomUUID());
  await staff.grant('governance:platform', DECIDE_ACTION[kind]);
  await staff.grant('governance:platform', RULE_PUBLISH_ACTION);
  const owner = stack.composition.dependencies.governance!.store;
  const rules = stack.composition.dependencies.governance!.rules!;
  const source = await proposal(reporter, `OL${Math.floor(Math.random() * 900000000) + 100000000}W`,
    'Retained reported title', 1);
  const target = { owner: 'source' as const, resource: source.record, component: 'record' as const };
  const reportInput: ReportInput = { kind, actingSubject: reporter.actor,
    authority: { kind: 'platform', scopeId: 'governance:platform' }, context: GLOBAL_CONTEXT,
    target, disclosure: 'private', reasonCode: 'spam', statement: 'Review this exact reported source',
    evidence: [{ ...target, revision: source.observation, locator: null }], idempotencyKey: randomUUID(),
    ...(kind === 'rights_complaint' ? { complaint: { process: 'ordinary_dispute' as const,
      claimantKind: 'rights_holder' as const, claimantName: 'Claimant', claimantContact: null,
      claimedWork: 'Original work', claimedRight: 'copyright' as const, noticeDigest: 'a'.repeat(64),
      noticeReceivedAt: new Date().toISOString() } } : {}) };
  const report = await owner.submitReport(await principal(reporter), reportInput);
  const rule = await rules.publish(await principal(staff), { ref: `urn:rezics:rule:${randomUUID()}`,
    scopeId: 'governance:platform', actingSubject: staff.actor, expectedRevision: null,
    document: { rule: 'Review the retained evidence' }, idempotencyKey: randomUUID() });
  const input: DecisionInput = { caseId: report.caseId, expectedGeneration: report.caseGeneration,
    actingSubject: staff.actor, outcome: 'dismiss', targets: [],
    rule: { ref: rule.ref, revision: rule.revision, digest: rule.digest }, evidenceDigest: report.evidenceDigest,
    reversesDecisionId: null, answersStepId: null, rationale: 'Evidence reviewed', disclosure: 'private',
    idempotencyKey: randomUUID(), reasons: { facts: 'Reviewed the retained source', scope: 'This report',
      duration: 'Until reconsidered', automation: false, contentLanguage: 'en',
      appealRoute: '/v1/public-reports/{caseId}/correspondence' } };
  return { staff, reporter, owner, rules, input, rule };
}

async function governanceSnapshot(caseId: string) {
  return (await stack.accessPool.query(`SELECT to_jsonb(c) AS case,
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM access.moderation_decision d WHERE d.case_id = c.id) AS decisions,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY decision_id, ordinal) FROM access.moderation_decision_target t
      JOIN access.moderation_decision d ON d.id = t.decision_id WHERE d.case_id = c.id) AS targets,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY decision_id) FROM access.safety_decision_operation o
      JOIN access.moderation_decision d ON d.id = o.decision_id WHERE d.case_id = c.id) AS operations,
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY decision_id, ordinal) FROM access.safety_decision_effect e
      JOIN access.moderation_decision d ON d.id = e.decision_id WHERE d.case_id = c.id) AS effects,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM access.governance_process_step s WHERE s.case_id = c.id) AS steps
    FROM access.governance_case c WHERE id = $1`, [caseId])).rows;
}

function decisionEntry(operation: string, kind: 'content_report' | 'rights_complaint', authorityClass: AuthorityClass): ReplayEntry {
  return { operation, authorityClass, losses: losses(authorityClass), scope: 'governance:platform', action: DECIDE_ACTION[kind],
    family: `${operation.split('/v1/')[1]} ${authorityClass}`, owners: ['modules/governance/store.ts#GovernanceStore.decide'],
    subcases: ['dismiss retained evidence'], denied: GovernanceDenied, conflict: GovernanceConflict, registration: 'turned',
    requestBuilder: async () => {
      const f = await decisionFixture(kind);
      const member = await stack.member(randomUUID());
      const lose = await authority(member, 'governance:platform', DECIDE_ACTION[kind], authorityClass);
      await f.owner.safety.claim(await principal(member), member.actor, f.input.caseId);
      const input = { ...f.input, actingSubject: member.actor };
      return { command: async (fresh, changed) => {
        const result = await f.owner.decide(await principal(member), { ...input,
          ...(fresh ? { idempotencyKey: randomUUID() } : {}), ...(changed ? { rationale: 'Different binding' } : {}) }, true);
        expect(result.operation.status).toBe('completed');
        return result;
      }, lose, advance: async () => {
        const next = await f.rules.publish(await principal(f.staff), { ref: f.rule.ref, scopeId: 'governance:platform',
          actingSubject: f.staff.actor, expectedRevision: f.rule.revision,
          document: { rule: 'A later rule head' }, idempotencyKey: randomUUID() });
        expect(next.revision).not.toBe(f.rule.revision);
      }, snapshot: () => governanceSnapshot(input.caseId) };
    } };
}

function stepEntry(authorityClass: AuthorityClass): ReplayEntry {
  return { operation: 'POST /v1/governance/process-steps', authorityClass, losses: losses(authorityClass),
    scope: 'governance:platform', action: 'governance.moderate | governance.rights.decide | governance.appeal',
    family: `Governance process steps ${authorityClass}`, owners: ['modules/governance/store.ts#GovernanceStore.recordStep'],
    subcases: ['moderator message', 'rights message', 'represented party appeal'],
    denied: GovernanceDenied, conflict: GovernanceConflict, registration: 'turned',
    requestBuilder: async subcase => {
      const kind = subcase === 'rights message' ? 'rights_complaint' : 'content_report';
      const f = await decisionFixture(kind);
      await f.owner.safety.claim(await principal(f.staff), f.staff.actor, f.input.caseId);
      const decision = await f.owner.decide(await principal(f.staff), f.input, true);
      expect(decision.operation.status).toBe('completed');
      const member = await stack.member(randomUUID());
      const party = subcase === 'represented party appeal';
      const lose = await authority(member, 'governance:platform', party ? APPEAL_ACTION : DECIDE_ACTION[kind], authorityClass);
      const input: StepInput = { caseId: f.input.caseId, decisionId: decision.decisionId,
        actingSubject: member.actor, process: kind === 'rights_complaint' ? 'ordinary_dispute' : 'platform_appeal',
        step: party ? 'appeal' : 'message', partySubject: party ? member.actor : null,
        statement: 'Retained process statement', documentDigest: null, occurredAt: new Date().toISOString(),
        dueAt: null, idempotencyKey: randomUUID() };
      return { command: async (fresh, changed) => f.owner.recordStep(await principal(member), { ...input,
        ...(fresh ? { idempotencyKey: randomUUID() } : {}), ...(changed ? { statement: 'Different binding' } : {}) }),
      lose, advance: async () => {
        const next = await f.owner.recordStep(await principal(f.staff), { ...input, actingSubject: f.staff.actor,
          step: 'message', partySubject: null, statement: 'Later process step', idempotencyKey: randomUUID() });
        expect(next.replayed).toBe(false);
      }, snapshot: () => governanceSnapshot(input.caseId) };
    } };
}

function assessmentEntry(authorityClass: AuthorityClass): ReplayEntry {
  return { operation: 'POST /v1/rights/use-assessments', authorityClass, losses: losses(authorityClass),
    scope: ASSESS_SCOPE, action: ASSESS_ACTION, family: `Rights use assessments ${authorityClass}`,
    owners: ['modules/rights/store.ts#RightsStore.assess'], subcases: ['data rights', 'service terms'],
    denied: RightsDenied, conflict: RightsConflict, registration: 'turned',
    requestBuilder: async subcase => {
      const member = await stack.member(randomUUID());
      const successor = await stack.member(randomUUID());
      const lose = await authority(member, ASSESS_SCOPE, ASSESS_ACTION, authorityClass);
      await successor.grant(ASSESS_SCOPE, ASSESS_ACTION);
      const service = subcase === 'service terms';
      const work = service ? undefined : await workFixture();
      const input: AssessmentInput = { actingSubject: member.actor,
        material: service ? { scopeKind: 'source_provider', provider: `replay-${randomUUID()}`, namespace: 'work',
          sourceRecordId: null, contentVariantId: null, mediaAsset: null, component: 'response' }
          : { scopeKind: 'work', provider: null, namespace: null, sourceRecordId: null,
            contentVariantId: null, mediaAsset: null, workId: work!.created.work, component: 'title' },
        family: service ? 'service_terms' : 'data_rights', useKind: 'acquisition', useScope: 'rezics:replay-assessment',
        expressionKind: service ? 'service' : 'fact', basis: service ? 'service_terms' : 'unprotected_fact',
        outcome: 'supported', licenseInstrument: null, exceptionKind: null, rationale: 'Retained rights assessment',
        extent: {}, evidence: {}, obligations: [], expectedAssessment: null, idempotencyKey: randomUUID() };
      const owner = stack.composition.dependencies.rights!.store;
      let saved: Awaited<ReturnType<typeof owner.assess>>;
      let advanced = false;
      return { command: async (fresh, changed) => {
        const result = await owner.assess(await principal(member), { ...input,
          ...(fresh ? { idempotencyKey: randomUUID() } : {}), ...(changed ? { rationale: 'Different binding' } : {}) });
        saved ??= result;
        // revision is a live head marker, not part of the saved assessment.
        // Check it separately while the driver compares every retained witness.
        const { revision, ...witness } = result;
        expect(revision).toBe(advanced ? null : '1');
        return witness;
      }, lose, advance: async () => {
        const next = await owner.assess(await principal(successor), { ...input, actingSubject: successor.actor,
          expectedAssessment: saved.assessmentId, rationale: 'Later assessment', idempotencyKey: randomUUID() });
        expect(next.predecessor).toBe(saved.assessmentId);
        expect(next.revision).toBe('2');
        advanced = true;
      }, snapshot: async () => (await stack.contentPool.query(`SELECT to_jsonb(m) AS material,
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM rights.use_assessment a WHERE a.material_id = m.id) AS assessments,
        (SELECT jsonb_agg(to_jsonb(h) ORDER BY family, use_kind, use_scope) FROM rights.use_assessment_head h
          WHERE h.material_id = m.id) AS heads,
        (SELECT jsonb_agg(to_jsonb(o) ORDER BY assessment_id, ordinal) FROM rights.obligation o
          JOIN rights.use_assessment a ON a.id = o.assessment_id WHERE a.material_id = m.id) AS obligations
        FROM rights.material m WHERE id = $1`, [saved.materialId])).rows };
    } };
}

function erasureEntry(authorityClass: AuthorityClass): ReplayEntry {
  return { operation: 'POST /v1/erasures', authorityClass, losses: losses(authorityClass),
    scope: 'erasure:{work}', action: 'erasure.request', family: `Content erasure ${authorityClass}`,
    owners: ['modules/erasure/request.ts#requestContentErasure'], subcases: ['unpublished Content revision'],
    denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'turned',
    requestBuilder: async () => {
      const { author, created, variant, draft } = await contentFixture();
      const member = await stack.member(randomUUID());
      const lose = await authority(member, `erasure:${created.work}`, 'erasure.request', authorityClass);
      const deps = stack.composition.dependencies;
      const successor = await saveAdmittedContentDraft(stack.env, stack.content, deps.account, stack.access,
        request(author), { resourceId: created.work, variant, expectedHead: draft.revisionId!,
          body: 'Current Content above the historical erasure target', actingSubject: author.actor,
          idempotencyKey: randomUUID() });
      expect(successor.outcome).toBe('succeeded');
      const input = { resourceId: created.work, actingSubject: member.actor,
        revisionIds: [draft.revisionId!], idempotencyKey: randomUUID() };
      let saved: Awaited<ReturnType<typeof requestContentErasure>>;
      return { command: async (fresh, changed) => {
        const result = await requestContentErasure(deps.erasures!, stack.env, deps.account, stack.access, request(member),
          { ...input, ...(fresh ? { idempotencyKey: randomUUID() } : {}),
            ...(changed ? { revisionIds: [...input.revisionIds, randomUUID()] } : {}) });
        expect(result.report.suppression).toBe('suppressed');
        saved ??= result;
        return result;
      }, lose, advance: async () => {
        const next = await saveAdmittedContentDraft(stack.env, stack.content, deps.account, stack.access, request(author),
          { resourceId: created.work, variant, expectedHead: successor.revisionId!, body: 'Later unerased Content',
            actingSubject: author.actor, idempotencyKey: randomUUID() });
        expect(next.outcome).toBe('succeeded');
        expect(next.revisionId).not.toBe(draft.revisionId);
      }, snapshot: async () => ({ report: await readErasure(deps.erasures!.relay, saved.report.erasureId),
        content: await contentSnapshot(created.work, member) }) };
    } };
}

export const entries: ReplayEntry[] = [
  { operation: "POST /v1/governance/rules", authorityClass: 'domain-grant',
    scope: "governance:platform", action: "governance.rule.publish", family: 'governance rule publication', owners: ['modules/governance/rules.ts#GovernanceRules.publish'],
    subcases: ['rule revision'], denied: GovernanceDenied, conflict: GovernanceConflict, registration: 'turned',
    requestBuilder: async () => {
      const member = await stack.member(randomUUID());
      const grant = await member.grant('governance:platform', RULE_PUBLISH_ACTION);
      const owner = new GovernanceRules(stack.accessPool);
      const input = { ref: `urn:rezics:rule:${randomUUID()}`, scopeId: 'governance:platform',
        actingSubject: member.actor, expectedRevision: null, document: { rule: 'Review retained evidence.' },
        idempotencyKey: randomUUID() };
      return { command: async (fresh, changed) => owner.publish(await principal(member), { ...input,
        ...(fresh ? { idempotencyKey: randomUUID() } : {}),
        ...(changed ? { document: { rule: 'Different binding.' } } : {}) }),
      lose: loss => loseGrant(member, grant, loss),
      snapshot: async () => (await stack.accessPool.query(`SELECT to_jsonb(r) AS row
        FROM access.governance_rule_revision r WHERE ref = $1 ORDER BY revision`, [input.ref])).rows };
    } },
  // These admission actions require their exact mandate; agent.control is not
  // an admitted representation alternative (AccessAdmissionRegistry.register).
  ...(['protection', 'proposal', 'decision'] as const).map(kind => workEntry(kind, 'domain-grant')),
  ...(['protection', 'proposal', 'decision'] as const).map(kind => contentEntry(kind, 'domain-grant')),
  erasureEntry('domain-grant'),
  ...authorityClasses.flatMap(authorityClass => [
    decisionEntry('POST /v1/moderation/decisions', 'content_report', authorityClass),
    decisionEntry('POST /v1/rights/restrictions', 'rights_complaint', authorityClass),
    decisionEntry('POST /v1/safety-cases/{}/decisions', 'content_report', authorityClass),
    stepEntry(authorityClass), assessmentEntry(authorityClass),
  ]),
];

export const area = "governance";
export const moduleOwners = ["governance", "erasure", "rights", "public-report", "protection"];
export const replayEntries = [...entries, ...related0];
export const coveredOperations = [...new Set(replayEntries.map(entry => entry.operation))];
export const uncoveredOperations: string[] = [
  "POST /v1/public-reports/{}/correspondence",
  "POST /v1/public-reports",
  "POST /v1/safety-decisions/{}/cancellation",
];
