import { randomUUID } from 'node:crypto';
import { expect } from 'bun:test';
import { AdmissionConflict, AdmissionDenied } from '../../src/modules/access/admission.ts';
import { deactivateFixtureController, grantFixtureAuthority, reduceFixtureGrant } from '../../src/modules/access/fixture-authority.ts';
import { createAdmittedMetadataWork } from '../../src/modules/work/create-admitted.ts';
import { editAdmittedMetadataWork, setAdmittedWorkScalar } from '../../src/modules/work/edit-admitted.ts';
import { stateWorkType } from '../../src/modules/work/type-command.ts';
import { setWorkMetadata } from '../../src/modules/work/metadata-command.ts';
import { metadataComponent, type MetadataHeaderState } from '../../src/modules/work/metadata-schema.ts';
import { readTitleControl } from '../../src/modules/work/title-control.ts';
import { createAdmittedWorkDerivation } from '../../src/modules/work/derivations.ts';
import { WorkMaintainers } from '../../src/modules/work/maintainers.ts';
import { RealmVariantRecommendationConflict, RealmVariantRecommendationStore,
  readRealmVariantDecision } from '../../src/modules/work/realm-variant-recommendation.ts';
import { readEligibleNativeVariant, readMainDefaultVariant } from '../../src/modules/work/native-variants.ts';
import { selectAdmittedMainDefault } from '../../src/modules/work/select-main-admitted.ts';
import { selectAdmittedRealmLocal } from '../../src/modules/work/select-realm-admitted.ts';
import { rejectAdmittedRealmLocal } from '../../src/modules/work/reject-realm-admitted.ts';
import { createAdmittedRealmSpace } from '../../src/modules/space/create-admitted.ts';
import { changeAdmittedWorkStructurePublication } from '../../src/modules/work/structured-publication-admitted.ts';
import { withStructuredPublicationFence } from '../../src/routes/publication.ts';
import { createAdmittedComposition, changeAdmittedComposition } from '../../src/modules/structure/change-admitted.ts';
import { derivedId } from '../../src/modules/structure/graph.ts';
import { structureProfileFor } from '../../src/modules/structure/profiles.ts';
import { identifyPost } from '../../src/modules/post/identification.ts';
import { readDefinitionByKey } from '../../src/modules/relation/change.ts';
import { systemDisclosure } from '../../src/modules/target/disclosed-references.ts';
import { admittedSemanticChange } from '../../src/modules/semantic/admitted.ts';
import { retireAuthorCredit } from '../../src/modules/work/author-credit-retirement.ts';
import { sourceChildOccurrence } from '../../src/modules/source/child-correspondence.ts';
import { SourceNativeWorkAdoptionStore } from '../../src/modules/source/native-work-adoption.ts';
import { SourceAuthorCreditStore } from '../../src/modules/source/author-credit.ts';
import { saveMemberReplyDraft } from '../../src/modules/content-publication/reply-draft.ts';
import { createAdmittedTextContribution } from '../../src/modules/contribution/create-admitted.ts';
import { editAdmittedTextContribution } from '../../src/modules/contribution/edit-admitted.ts';
import { publishAdmittedTextContribution } from '../../src/modules/contribution/publish-admitted.ts';
import { saveAdmittedContentDraft, type AuthoredContentDraftInput } from '../../src/modules/content-publication/draft.ts';
import { createAdmittedContentComment } from '../../src/modules/content-publication/comment.ts';
import { publishAdmittedContent } from '../../src/modules/content-publication/publish-admitted.ts';
import { selectAdmittedPublicContentSearch } from '../../src/modules/content-publication/eligibility-admitted.ts';
import { EditorialReviewStore, type EditorialCall } from '../../src/modules/editorial-review/store.ts';
import { EditorialBlocked } from '../../src/modules/editorial-review/contract.ts';
import { type ReplayEntry, type Scenario, type Member, stack, request, principal, head } from './fixtures.ts';

const deps = () => stack.composition.dependencies;

// Setup calls the admitted owners too: no fixture manufactures admissions,
// receipts, Content revisions or graph effects for the replay under test.
async function workFor(member: Member, semanticTypes?: string[]) {
  await member.grant('work:create:root', 'work.create');
  const created = await createAdmittedMetadataWork(stack.env, deps().account, stack.access, request(member), {
    actingSubject: member.actor, title: `Editorial replay ${randomUUID()}`, language: 'en',
    idempotencyKey: randomUUID(), semanticTypes,
  });
  await member.grant(`work:read:${created.work}`, 'work.read');
  return created;
}

async function snapshot(member: Member, resources: string[]) {
  const admissions = (await stack.accessPool.query<{ row: { id: string } }>(
    'SELECT to_jsonb(a) AS row FROM access.admission a WHERE principal_id = $1 ORDER BY id',
    [member.principalId])).rows;
  const operations = admissions.flatMap(({ row }) => [row.id, `content-draft:${row.id}`]);
  const graph = (await stack.fuseki.query(`SELECT DISTINCT ?g ?s ?p ?o WHERE {
    { SELECT DISTINCT ?s WHERE {
      { VALUES ?s { ${resources.map(resource => `<${resource}>`).join(' ')} } }
      UNION { VALUES ?root { ${resources.map(resource => `<${resource}>`).join(' ')} }
        GRAPH ?relatedGraph { ?s ?link ?root } }
    } }
    GRAPH ?g { ?s ?p ?o }
  } ORDER BY ?g ?s ?p ?o LIMIT 4096`)).results?.bindings ?? [];
  expect(graph.length).toBeLessThan(4096);
  return {
    admissions,
    graph,
    variants: (await stack.contentPool.query('SELECT to_jsonb(v) AS row FROM content.variant v WHERE resource_id = ANY($1) ORDER BY id', [resources])).rows,
    revisions: (await stack.contentPool.query(`SELECT to_jsonb(r) AS row FROM content.revision r
      JOIN content.variant v ON v.id = r.variant_id WHERE v.resource_id = ANY($1) ORDER BY r.id`, [resources])).rows,
    receipts: (await stack.contentPool.query(`SELECT to_jsonb(r) AS row FROM content.receipt r
      LEFT JOIN content.variant v ON v.id = r.variant_id
      WHERE r.operation_id = ANY($1) OR v.resource_id = ANY($2) ORDER BY r.operation_id`, [operations, resources])).rows,
    preparations: (await stack.contentPool.query(`SELECT to_jsonb(p) AS row FROM content.publication_preparation p
      JOIN content.revision r ON r.id = p.revision_id JOIN content.variant v ON v.id = r.variant_id
      WHERE v.resource_id = ANY($1) ORDER BY p.operation_id`, [resources])).rows,
    comments: (await stack.contentPool.query('SELECT to_jsonb(c) AS row FROM content.comment c WHERE resource_id = ANY($1) ORDER BY id', [resources])).rows,
  };
}

async function grantLoss(member: Member, grant: string, loss: 'expired' | 'revoked') {
  // Expire just the selected domain grant, keeping unrelated setup/read
  // authority live so the ordinary refusal is the exact action being tested.
  await reduceFixtureGrant(stack.accessPool, grant, loss === 'expired'
    ? { validUntil: new Date(0) } : { active: false });
}

const headerState = (description: string): MetadataHeaderState => ({ kind: 'header', originalTitle: null,
  localized: [{ language: 'en', title: null, description, mainVersionLabel: null }] });

function admittedEntry(operation: string, family: string, owner: string, scope: string, action: string,
  requestBuilder: ReplayEntry['requestBuilder'], subcases = ['represented-agent']): ReplayEntry {
  return { operation, family, owners: [owner], scope, action, authorityClass: 'domain-grant',
    denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'registered-failing', subcases, requestBuilder };
}

async function workEdit(kind: string): Promise<Scenario> {
  const member = await stack.member(randomUUID()), work = await workFor(member);
  const grant = await member.grant(`work:edit:${work.work}`, 'work.edit');
  const key = randomUUID(), originalHead = work.workRevision;
  const basis = (await readTitleControl(stack.env, work.work)).basis;
  const state = headerState('Saved description');
  const component = metadataComponent(work.work, state);
  let receipt = '', metadataRevision = '';
  const command = async (fresh?: boolean, changed?: boolean) => {
    const idempotencyKey = fresh ? randomUUID() : key;
    const expectedHead = fresh ? await head(work.work) : originalHead;
    let result;
    if (kind === 'title-control') {
      result = await editAdmittedMetadataWork(stack.env, deps().account, stack.access, request(member), {
        work: work.work, expectedHead, title: changed ? 'Other binding' : 'Saved title', language: 'en',
        titleControl: fresh ? (await readTitleControl(stack.env, work.work)).basis : basis,
        actingSubject: member.actor, idempotencyKey,
      });
    } else if (kind === 'type') {
      result = await stateWorkType(stack.env, deps().account, stack.access, request(member), {
        work: work.work, expectedHead, types: [changed ? 'https://schema.org/DigitalDocument' : 'https://schema.org/Book'],
        actingSubject: member.actor, idempotencyKey,
      });
    } else if (kind === 'scalar') {
      result = await setAdmittedWorkScalar(stack.env, deps().account, stack.access, request(member), {
        work: work.work, expectedHead, scalarValue: { kind: changed ? 'no-value' : 'unknown' },
        actingSubject: member.actor, idempotencyKey,
      });
    } else {
      result = await setWorkMetadata(deps(), request(member), {
        work: work.work, expectedHead: null,
        state: changed ? headerState('Other binding') : state, actingSubject: member.actor, idempotencyKey,
      });
    }
    receipt ||= result.receipt;
    metadataRevision ||= result.revision;
    return result;
  };
  return { command, lose: loss => grantLoss(member, grant, loss),
    advance: async () => {
      if (kind === 'title-control') {
        await editAdmittedMetadataWork(stack.env, deps().account, stack.access, request(member), {
          work: work.work, expectedHead: await head(work.work), title: 'Advanced title', language: 'en',
          titleControl: (await readTitleControl(stack.env, work.work)).basis,
          actingSubject: member.actor, idempotencyKey: randomUUID(),
        });
      } else if (kind === 'metadata') {
        await setWorkMetadata(deps(), request(member), { work: work.work, expectedHead: metadataRevision,
          state: headerState('Advanced description'), actingSubject: member.actor, idempotencyKey: randomUUID() });
      } else await setAdmittedWorkScalar(stack.env, deps().account, stack.access, request(member), {
      work: work.work, expectedHead: await head(work.work), scalarValue: { kind: 'boolean', lexical: 'false' },
      actingSubject: member.actor, idempotencyKey: randomUUID(),
    }); }, snapshot: () => snapshot(member, [work.work, component, receipt]) };
}

async function contributionDraft(member: Member, work: string) {
  await member.grant(`contribution:create:${work}`, 'contribution.create');
  const draft = await createAdmittedTextContribution(stack.env, deps().account, stack.access, request(member), {
    work, language: 'en', body: 'Retained contribution text', actingSubject: member.actor, idempotencyKey: randomUUID(),
  });
  expect(draft.outcome).toBe('succeeded');
  if (!draft.contribution || !draft.draftRevision) throw new Error('Contribution setup has no retained revision');
  await member.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
  return { contribution: draft.contribution, revision: draft.draftRevision };
}

async function contributionCommand(kind: string): Promise<Scenario> {
  const member = await stack.member(randomUUID()), work = await workFor(member);
  await member.grant(`work:edit:${work.work}`, 'work.edit');
  const draft = kind === 'create' ? null : await contributionDraft(member, work.work);
  const scope = kind === 'create' ? `contribution:create:${work.work}` : `contribution:${kind}:${draft!.contribution}`;
  const grant = await member.grant(scope, `contribution.${kind}`);
  const key = randomUUID();
  let receipt = '', contribution = draft?.contribution ?? '';
  let published: string | null = null, draftRevision = draft?.revision ?? '';
  const command = async (fresh?: boolean, changed?: boolean) => {
    const common = { actingSubject: member.actor, idempotencyKey: fresh ? randomUUID() : key };
    let result;
    if (kind === 'create') {
      result = await createAdmittedTextContribution(stack.env, deps().account, stack.access, request(member), {
        ...common, work: work.work, language: 'en', body: changed ? 'Other binding' : 'Saved text',
      });
    } else if (kind === 'edit') {
      result = await editAdmittedTextContribution(stack.env, deps().account, stack.access, request(member), {
        ...common, contribution: draft!.contribution, expectedHead: draft!.revision,
        body: changed ? 'Other binding' : 'Saved text',
      });
    } else {
      result = await publishAdmittedTextContribution(stack.env, deps().account, stack.access, request(member), {
        ...common, contribution: draft!.contribution, expectedDraftHead: draft!.revision,
        expectedPublicationHead: changed ? draft!.revision : fresh ? published : null,
        disclosure: 'public', rightsBasis: 'original-contribution',
      });
      published ??= result.publicationDecision ?? null;
    }
    expect(result.outcome).toBe('succeeded');
    receipt ||= result.receipt;
    contribution ||= result.contribution ?? '';
    if ('draftRevision' in result) draftRevision = result.draftRevision ?? draftRevision;
    return result;
  };
  return { command, lose: loss => grantLoss(member, grant, loss),
    advance: async () => {
      if (kind === 'publish') await publishAdmittedTextContribution(stack.env, deps().account, stack.access, request(member), {
        contribution, expectedDraftHead: draftRevision, expectedPublicationHead: published,
        disclosure: 'public', rightsBasis: 'original-contribution', actingSubject: member.actor, idempotencyKey: randomUUID(),
      });
      else {
        await member.grant(`contribution:edit:${contribution}`, 'contribution.edit');
        await editAdmittedTextContribution(stack.env, deps().account, stack.access, request(member), {
          contribution, expectedHead: draftRevision, body: 'Advanced contribution text',
          actingSubject: member.actor, idempotencyKey: randomUUID(),
        });
      }
    }, snapshot: () => snapshot(member, [work.work, contribution, receipt]) };
}

async function contentDraft(member: Member, work: string) {
  await member.grant(`content:draft:${work}`, 'content.draft');
  const input: AuthoredContentDraftInput = { resourceId: work,
    variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
    expectedHead: null, body: 'Retained paragraph', actingSubject: member.actor, idempotencyKey: randomUUID() };
  const saved = await saveAdmittedContentDraft(stack.env, stack.content, deps().account, stack.access, request(member), input);
  expect(saved.outcome).toBe('succeeded');
  if (!saved.revisionId) throw new Error('Content setup has no retained revision');
  return { input, saved: { ...saved, revisionId: saved.revisionId } };
}

async function contentCommand(kind: string): Promise<Scenario> {
  const member = await stack.member(randomUUID()), work = await workFor(member);
  await member.grant(`work:edit:${work.work}`, 'work.edit');
  const draft = await contentDraft(member, work.work);
  const action = kind === 'eligibility' ? 'search-eligibility' : kind;
  const grant = await member.grant(`content:${action}:${work.work}`, `content.${action}`);
  const key = randomUUID();
  const publication = { resourceId: work.work, variantId: draft.input.variant.id,
    revisionId: draft.saved.revisionId, expectedDigest: draft.saved.byteDigest,
    expectedContentEpoch: draft.saved.position.dataEpoch, expectedPublicationHead: null,
    preparationId: randomUUID(), actingSubject: member.actor, idempotencyKey: kind === 'eligibility' ? randomUUID() : key };
  let decision: string | null = null, receipt = '', savedDraftRevision = draft.saved.revisionId,
    eligibilityDecision: string | null = null;
  if (kind === 'eligibility') {
    await member.grant(`content:publish:${work.work}`, 'content.publish');
    const published = await publishAdmittedContent(stack.env, stack.content, deps().account, stack.access, request(member), publication);
    expect(published.status).toBe('active');
    decision = published.decision;
  }
  return { command: async (fresh, changed) => {
    const idempotencyKey = fresh ? randomUUID() : key;
    if (kind === 'draft') {
      const result = await saveAdmittedContentDraft(stack.env, stack.content, deps().account, stack.access, request(member), {
        ...draft.input, expectedHead: draft.saved.revisionId, body: changed ? 'Other binding' : 'Saved paragraph', idempotencyKey,
      });
      savedDraftRevision = result.revisionId!;
      return result;
    }
    if (kind === 'comment') {
      return createAdmittedContentComment(stack.env, deps().comments!, deps().account, stack.access, request(member), {
        resourceId: work.work, revisionId: draft.saved.revisionId, author: member.actor,
        exact: 'Retained paragraph', body: changed ? 'Other binding' : 'Saved comment', idempotencyKey,
      });
    }
    if (kind === 'publish') {
      const result = await publishAdmittedContent(stack.env, stack.content, deps().account, stack.access, request(member), {
        ...publication, idempotencyKey, preparationId: changed || fresh ? randomUUID() : publication.preparationId,
      });
      expect(result.status).toBe('active');
      receipt ||= result.receipt;
      decision ??= result.decision;
      return result;
    }
    const result = await selectAdmittedPublicContentSearch(stack.env, stack.content, deps().account, stack.access, request(member), {
      resourceId: work.work, variantId: draft.input.variant.id, publicationDecision: decision!,
      expectedEligibilityHead: changed ? decision : null, rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: member.actor, idempotencyKey,
    });
    expect(result.outcome).toBe('succeeded');
    receipt ||= result.receipt;
    eligibilityDecision ??= result.decision;
    return result;
  }, lose: loss => grantLoss(member, grant, loss),
  advance: async () => {
    if (kind === 'draft' || kind === 'comment') await saveAdmittedContentDraft(stack.env, stack.content,
      deps().account, stack.access, request(member), { ...draft.input, expectedHead: savedDraftRevision,
        body: 'Advanced paragraph', idempotencyKey: randomUUID() });
    else if (kind === 'publish') await publishAdmittedContent(stack.env, stack.content, deps().account, stack.access,
      request(member), { ...publication, expectedPublicationHead: decision,
        preparationId: randomUUID(), idempotencyKey: randomUUID() });
    else await selectAdmittedPublicContentSearch(stack.env, stack.content, deps().account, stack.access, request(member), {
      resourceId: work.work, variantId: draft.input.variant.id, publicationDecision: decision!,
      expectedEligibilityHead: eligibilityDecision, rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: member.actor, idempotencyKey: randomUUID(),
    });
  }, snapshot: () => snapshot(member, [work.work, draft.input.variant.id, ...(receipt ? [receipt] : [])]) };
}

async function controllerFor(member: Member) {
  const spare = await stack.member(randomUUID());
  const authority = await grantFixtureAuthority(stack.accessPool, {
    scope: 'work:create:root', requireDispatch: true,
    representations: [
      { principalId: member.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' },
      { principalId: spare.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' },
    ], grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' },
  });
  return authority.representationIds[0]!;
}

async function editorialCommand(kind: string, authorityClass: ReplayEntry['authorityClass'], outcome = 'rejected'): Promise<Scenario> {
  const proposer = await stack.member(randomUUID()), reviewer = await stack.member(randomUUID());
  await controllerFor(proposer);
  const reviewerControl = await controllerFor(reviewer);
  const work = await workFor(proposer);
  await proposer.grant(`work:edit:${work.work}`, 'work.edit');
  await reviewer.grant(`work:edit:${work.work}`, 'work.edit');
  await reviewer.grant(`work:read:${work.work}`, 'work.read');
  const reviewGrant = await reviewer.grant(`work:review:${work.work}`, 'work.review');
  const member = kind === 'review' || kind === 'decide' ? reviewer : proposer;
  const control = member === reviewer ? reviewerControl : (await stack.accessPool.query<{ id: string }>(
    "SELECT id FROM access.representation WHERE principal_id = $1 AND subject_id = $2 AND action = 'agent.control' AND active",
    [proposer.principalId, proposer.actor])).rows[0]!.id;
  const owner = new EditorialReviewStore(stack.accessPool);
  const call = async (actor: Member): Promise<EditorialCall> => ({ work: deps(), request: request(actor),
    principal: await principal(actor), actingSubject: actor.actor });
  const input = { kind: 'component-correction',
    target: { resource: work.work, revision: work.workRevision, context: 'urn:rezics:context:global' as const },
    candidate: { command: 'work-metadata', state: headerState('Reviewed description') },
    baseHeads: [{ component: metadataComponent(work.work, headerState('Reviewed description')), head: null }],
    evidence: [{ resource: work.work, revision: work.workRevision, locator: 'header' }],
  };
  const original = kind === 'create' ? null : await owner.create(await call(proposer), input, randomUUID());
  // Terminal decisions and revisions cannot be submitted fresh to the same
  // old revision. Keep another live proposal with identical authority needs.
  const freshProposal = kind === 'create' ? null : await owner.create(await call(proposer), input, randomUUID());
  if (kind === 'revert') {
    const applied = await owner.decide(await call(reviewer), original!.proposal, {
      revision: 1, outcome: 'applied', approve: true, message: 'Checked retained evidence',
    }, randomUUID());
    expect(applied.outcome).toBe('applied');
  }
  const key = randomUUID();
  let savedProposal = '';
  return { command: async (fresh, changed) => {
    const currentCall = await call(member), idempotencyKey = fresh ? randomUUID() : key;
    const id = (fresh ? freshProposal : original)?.proposal;
    let result;
    if (kind === 'create') result = await owner.create(currentCall, { ...input,
      ...(changed ? { candidate: { command: 'work-metadata', state: headerState('Other binding') } } : {}),
    }, idempotencyKey);
    else if (kind === 'revise') result = await owner.revise(currentCall, id!, { revision: 1,
      candidate: { command: 'work-metadata', state: headerState(changed ? 'Other binding' : 'Revised description') },
      baseHeads: input.baseHeads, evidence: input.evidence,
    }, idempotencyKey);
    else if (kind === 'withdraw') result = await owner.withdraw(currentCall, id!, changed ? 2 : 1, idempotencyKey);
    else if (kind === 'review') result = await owner.review(currentCall, id!, { revision: 1,
      outcome: 'approve', message: changed ? 'Other binding' : 'Checked retained evidence',
    }, idempotencyKey);
    else if (kind === 'revert') result = await owner.revert(currentCall, original!.proposal,
      changed ? [{ ...input.evidence[0]!, locator: 'other-binding' }] : input.evidence, idempotencyKey);
    else result = await owner.decide(currentCall, id!, { revision: 1, outcome: outcome as 'applied' | 'rejected', approve: outcome === 'applied',
      message: changed ? 'Other binding' : 'Checked retained evidence',
    }, idempotencyKey);
    savedProposal ||= result.proposal;
    return result;
  }, lose: loss => authorityClass === 'controller'
    ? deactivateFixtureController(stack.accessPool, control) : grantLoss(reviewer, reviewGrant, loss),
  advance: async () => { await setAdmittedWorkScalar(stack.env, deps().account, stack.access, request(proposer), {
    work: work.work, expectedHead: await head(work.work), scalarValue: { kind: 'unknown' },
    actingSubject: proposer.actor, idempotencyKey: randomUUID(),
  }); }, snapshot: async () => {
    const proposals = [original?.proposal, freshProposal?.proposal, savedProposal].filter((id): id is string => !!id);
    return { owner: await snapshot(member, [work.work, input.baseHeads[0]!.component]),
      proposals: (await stack.accessPool.query('SELECT to_jsonb(p) AS row FROM access.editorial_proposal p WHERE id = ANY($1::uuid[]) ORDER BY id', [proposals])).rows,
      revisions: (await stack.accessPool.query('SELECT to_jsonb(r) AS row FROM access.editorial_revision r WHERE proposal = ANY($1::uuid[]) ORDER BY proposal,n', [proposals])).rows,
      reviews: (await stack.accessPool.query('SELECT to_jsonb(r) AS row FROM access.editorial_review r WHERE proposal = ANY($1::uuid[]) ORDER BY id', [proposals])).rows,
      decisions: (await stack.accessPool.query('SELECT to_jsonb(d) AS row FROM access.editorial_decision d WHERE proposal = ANY($1::uuid[]) ORDER BY proposal', [proposals])).rows,
      events: (await stack.accessPool.query('SELECT to_jsonb(e) AS row FROM access.editorial_event e WHERE proposal = ANY($1::uuid[]) ORDER BY sequence', [proposals])).rows,
      receipts: (await stack.accessPool.query('SELECT to_jsonb(r) AS row FROM access.editorial_command_receipt r WHERE proposal = ANY($1::uuid[]) ORDER BY principal,idempotency_key', [proposals])).rows,
    };
  } };
}

function editorialEntry(operation: string, kind: string, authorityClass: ReplayEntry['authorityClass']): ReplayEntry {
  return { operation, authorityClass, family: `Editorial ${kind} (${authorityClass})`,
    scope: authorityClass === 'controller' ? 'Agent' : 'work:review:{work}',
    action: authorityClass === 'controller' ? 'agent.control' : 'work.review',
    owners: [`modules/editorial-review/store.ts#EditorialReviewStore.${kind}`],
    subcases: kind === 'decide' ? ['rejected', 'applied'] : ['component-correction'],
    losses: authorityClass === 'controller' ? ['revoked'] : ['expired', 'revoked'],
    denied: kind === 'review' || kind === 'decide' ? EditorialBlocked : AdmissionDenied,
    conflict: AdmissionConflict, registration: 'registered-failing',
    requestBuilder: subcase => editorialCommand(kind, authorityClass, subcase) };
}

async function derivationCommand(): Promise<Scenario> {
  const member = await stack.member(randomUUID()), target = await workFor(member), source = await workFor(member);
  const grant = await member.grant(`derivation:link:${target.work}`, 'work.derive');
  await member.grant(`work:edit:${target.work}`, 'work.edit');
  const input = { targetWork: target.work, targetMainVersion: target.mainVersion,
    expectedTargetHead: target.mainRevision, sourceWork: source.work, sourceMainVersion: source.mainVersion,
    sourceMainRevision: source.mainRevision, kind: 'adaptation' as const, evidence: 'https://example.test/derivation',
    actingSubject: member.actor, idempotencyKey: randomUUID() };
  let receipt = '', derivation = '';
  return { command: async (fresh, changed) => {
    const result = await createAdmittedWorkDerivation(stack.env, deps().account, stack.access, request(member), {
      ...input, ...(fresh ? { idempotencyKey: randomUUID() } : {}),
      ...(changed ? { evidence: 'https://example.test/other-binding' } : {}),
    });
    receipt ||= result.receipt; derivation ||= result.derivation;
    return result;
  }, lose: loss => grantLoss(member, grant, loss), advance: async () => {
    const published = await publishedContribution(member, target.work);
    await member.grant(`publication:select:${target.mainVersion}`, 'publication.select');
    await selectAdmittedMainDefault(stack.env, deps().account, stack.access, request(member), {
      work: target.work, context: { kind: 'main-version-default', id: target.mainVersion },
      contribution: published.contribution, publicationDecision: published.decision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer', actingSubject: member.actor, idempotencyKey: randomUUID(),
    });
  }, snapshot: () => snapshot(member, [target.work, source.work, derivation, receipt]) };
}

async function realmFor(member: Member) {
  await member.grant('space:create:root', 'space.create');
  const created = await createAdmittedRealmSpace(stack.env, deps().account, stack.access, request(member), {
    name: `Replay community ${randomUUID()}`, language: 'en', actingSubject: member.actor, idempotencyKey: randomUUID(),
  });
  expect(created.outcome).toBe('succeeded');
  if (!created.realm || !created.space) throw new Error('Realm setup has no owner receipt');
  return { realm: created.realm, space: created.space };
}

async function publishedContribution(member: Member, work: string) {
  await member.grant(`work:edit:${work}`, 'work.edit');
  const draft = await contributionDraft(member, work);
  await member.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
  const published = await publishAdmittedTextContribution(stack.env, deps().account, stack.access, request(member), {
    contribution: draft.contribution, expectedDraftHead: draft.revision, expectedPublicationHead: null,
    disclosure: 'public', rightsBasis: 'original-contribution', actingSubject: member.actor, idempotencyKey: randomUUID(),
  });
  expect(published.outcome).toBe('succeeded');
  if (!published.publicationDecision) throw new Error('Publication setup has no decision');
  return { ...draft, decision: published.publicationDecision };
}

async function publicationCommand(kind: string): Promise<Scenario> {
  const member = await stack.member(randomUUID()), work = await workFor(member);
  const draft = await publishedContribution(member, work.work);
  const realm = kind === 'main' ? null : await realmFor(member);
  const scope = kind === 'main' ? `publication:select:${work.mainVersion}`
    : `publication:${kind === 'reject' ? 'reject' : 'adopt'}:${realm!.realm}`;
  const grant = await member.grant(scope, kind === 'main' ? 'publication.select'
    : kind === 'reject' ? 'publication.reject' : 'publication.adopt');
  const key = randomUUID();
  let receipt = '';
  return { command: async (fresh, changed) => {
    const common = { work: work.work, expectedSelectionHead: changed ? work.workRevision : null,
      actingSubject: member.actor, idempotencyKey: fresh ? randomUUID() : key };
    let result;
    if (kind === 'main') result = await selectAdmittedMainDefault(stack.env, deps().account, stack.access, request(member), {
      ...common, context: { kind: 'main-version-default', id: work.mainVersion },
      contribution: draft.contribution, publicationDecision: draft.decision, selectionBasis: 'main-maintainer',
    });
    else if (kind === 'reject') result = await rejectAdmittedRealmLocal(stack.env, deps().account, stack.access, request(member), {
      ...common, context: { kind: 'realm-local', id: realm!.realm }, mainVersion: work.mainVersion,
      decisionBasis: 'realm-manager-review', reasonCode: 'not-approved',
    });
    else result = await selectAdmittedRealmLocal(stack.env, deps().account, stack.access, request(member), {
      ...common, context: { kind: 'realm-local', id: realm!.realm }, mainVersion: work.mainVersion,
      contribution: draft.contribution, publicationDecision: draft.decision, selectionBasis: 'realm-manager-review',
    }, stack.content);
    expect(result.outcome).toBe('succeeded');
    receipt ||= result.receipt;
    return result;
  }, lose: loss => grantLoss(member, grant, loss),
  advance: async () => { await setAdmittedWorkScalar(stack.env, deps().account, stack.access, request(member), {
    work: work.work, expectedHead: await head(work.work), scalarValue: { kind: 'unknown' },
    actingSubject: member.actor, idempotencyKey: randomUUID(),
  }); }, snapshot: () => snapshot(member, [work.work, work.mainVersion, draft.contribution,
    receipt, ...(realm ? [realm.realm, realm.space] : [])]) };
}

async function recommendationCommand(): Promise<Scenario> {
  const member = await stack.member(randomUUID()), work = await workFor(member), realm = await realmFor(member);
  const published = await publishedContribution(member, work.work);
  await member.grant(`publication:select:${work.mainVersion}`, 'publication.select');
  await selectAdmittedMainDefault(stack.env, deps().account, stack.access, request(member), {
    work: work.work, context: { kind: 'main-version-default', id: work.mainVersion },
    contribution: published.contribution, publicationDecision: published.decision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer', actingSubject: member.actor, idempotencyKey: randomUUID(),
  });
  const grant = await member.grant(`publication:adopt:${realm.realm}`, 'publication.adopt');
  const owner = new RealmVariantRecommendationStore(stack.accessPool);
  const input = { realm: realm.realm, mainVersion: work.mainVersion, contribution: published.contribution,
    expectedRevision: null, actingSubject: member.actor, idempotencyKey: randomUUID() };
  let revision = '';
  const eligible = async () => {
    if ((await readRealmVariantDecision(stack.env, realm.realm, work.mainVersion)).kind !== 'none') return false;
    const candidate = await readEligibleNativeVariant(stack.env, work.mainVersion, published.contribution);
    if (!candidate || candidate.work !== work.work) return false;
    const fallback = await readMainDefaultVariant(stack.env, work.mainVersion, candidate.variant.language);
    return candidate.variant.language === fallback.variant.language;
  };
  return { command: async (fresh, changed) => {
    await readRealmVariantDecision(stack.env, realm.realm, work.mainVersion);
    const result = await owner.set(await principal(member), { ...input,
      ...(fresh ? { idempotencyKey: randomUUID() } : {}),
      ...(changed ? { expectedRevision: randomUUID() } : {}),
    }, eligible);
    revision ||= result.recommendation!.revision;
    return result;
  }, advance: async () => { await owner.set(await principal(member), { ...input, contribution: null,
    expectedRevision: revision, idempotencyKey: randomUUID() }, eligible); },
  lose: loss => grantLoss(member, grant, loss), snapshot: async () => ({
    owner: await snapshot(member, [work.work, work.mainVersion, realm.realm]),
    hints: (await stack.accessPool.query(`SELECT to_jsonb(r) AS row FROM access.realm_native_variant_recommendation r
      WHERE realm = $1 AND main_version = $2`, [realm.realm, work.mainVersion])).rows,
    receipts: (await stack.accessPool.query(`SELECT to_jsonb(r) AS row FROM access.realm_native_variant_recommendation_receipt r
      WHERE principal_id = $1 ORDER BY idempotency_key`, [member.principalId])).rows,
  }) };
}

async function personFor(): Promise<Member> {
  const member = await stack.member(randomUUID(), { verified: true });
  const provisioned = await deps().agentProvisioning!.provision(deps().account, request(member), {
    kind: 'person', displayName: 'Editorial replay writer',
  }, randomUUID());
  expect(provisioned.state).toBe('active');
  const actor = provisioned.agent;
  return { ...member, actor, grant: async (scope, action) => (await grantFixtureAuthority(stack.accessPool, {
    scope, requireDispatch: true,
    representations: [{ principalId: member.principalId, actor, action,
      lifetime: action === 'agent.control' ? 'infinity' : '8 hours' }],
    grant: { actor, action, lifetime: action === 'agent.control' ? 'infinity' : '8 hours' },
  })).grantId };
}

async function maintainerCommand(action: string): Promise<Scenario> {
  const member = await personFor(), target = await personFor(), control = await controllerFor(member);
  const work = await workFor(member), owner = new WorkMaintainers(stack.accessPool, stack.env);
  await member.grant(`work:edit:${work.work}`, 'work.edit');
  const initial = await owner.read(work.work);
  if (action === 'remove') await owner.change(await principal(member), {
    work: work.work, actingSubject: member.actor, target: target.actor, action: 'add', expectedGeneration: initial.generation,
  }, randomUUID());
  const basis = await owner.read(work.work);
  const input = { work: work.work, actingSubject: member.actor, target: target.actor,
    action: action as 'add' | 'transfer' | 'remove', expectedGeneration: basis.generation };
  const key = randomUUID();
  return { command: async (fresh, changed) => owner.change(await principal(member), {
    ...input, ...(changed ? { expectedGeneration: '999' } : {}),
  }, fresh ? randomUUID() : key), lose: () => deactivateFixtureController(stack.accessPool, control),
  advance: async () => { await setAdmittedWorkScalar(stack.env, deps().account, stack.access, request(member), {
    work: work.work, expectedHead: await head(work.work), scalarValue: { kind: 'unknown' },
    actingSubject: member.actor, idempotencyKey: randomUUID(),
  }); }, snapshot: async () => ({ owner: await snapshot(member, [work.work, work.mainVersion]),
    roster: (await stack.accessPool.query('SELECT to_jsonb(m) AS row FROM access.work_maintainer m WHERE work = $1 ORDER BY agent', [work.work])).rows,
    set: (await stack.accessPool.query('SELECT to_jsonb(s) AS row FROM access.work_maintainer_set s WHERE work = $1', [work.work])).rows,
    receipts: (await stack.accessPool.query('SELECT to_jsonb(r) AS row FROM access.work_maintainer_receipt r WHERE work = $1 ORDER BY id', [work.work])).rows,
  }) };
}

async function structurePublicationCommand(operation: string): Promise<Scenario> {
  const member = await stack.member(randomUUID()), work = await workFor(member, ['https://schema.org/Recipe']);
  await member.grant(`work:edit:${work.work}`, 'work.edit');
  const profile = structureProfileFor('recipe-composition');
  await member.grant(`${profile.editScopePrefix}${work.work}`, profile.editAction);
  const structure = await createAdmittedComposition(stack.env, deps().account, stack.access, request(member), {
    profile: 'recipe-composition', work: work.work, mainVersion: work.mainVersion,
    actingSubject: member.actor, idempotencyKey: randomUUID(),
  });
  expect(structure.outcome).toBe('succeeded');
  if (!structure.structure || !structure.revision) throw new Error('Structure setup has no receipt');
  const grant = await member.grant(`work:publish:${work.work}`, operation === 'withdraw' ? 'work.withdraw-publication' : 'work.publish');
  const publication = { profile: 'work-structure-publication-v1' as const, operation: 'publish' as const,
    work: work.work, actingSubject: member.actor, expectedWorkHead: work.workRevision,
    expectedMainVersion: work.mainVersion, structure: structure.structure, expectedStructureHead: structure.revision,
    expectedPublicationHead: null, disclosure: 'public' as const, rightsBasis: 'original-contribution' as const,
    idempotencyKey: randomUUID() };
  const dispatch = (input: Parameters<typeof changeAdmittedWorkStructurePublication>[4]) =>
    changeAdmittedWorkStructurePublication(stack.env, deps().account, stack.access, request(member), input,
      run => withStructuredPublicationFence(deps(), work.work, run));
  let publicationHead = '';
  if (operation === 'withdraw') {
    await member.grant(`work:publish:${work.work}`, 'work.publish');
    const published = await dispatch(publication);
    expect(published.outcome).toBe('succeeded');
    publicationHead = published.publicationDecision!;
  }
  const key = randomUUID();
  let receipt = '';
  return { command: async (fresh, changed) => {
    const idempotencyKey = fresh ? randomUUID() : key;
    const result = operation === 'withdraw' ? await dispatch({ profile: publication.profile,
      operation: 'withdraw', work: work.work, actingSubject: member.actor, idempotencyKey,
      expectedPublicationHead: changed ? work.workRevision : publicationHead })
      : await dispatch({ ...publication, idempotencyKey,
        ...(changed ? { expectedWorkHead: work.mainRevision } : {}) });
    expect(result.outcome).toBe('succeeded');
    receipt ||= result.receipt;
    return result;
  }, lose: loss => grantLoss(member, grant, loss),
  advance: async () => { await setAdmittedWorkScalar(stack.env, deps().account, stack.access, request(member), {
    work: work.work, expectedHead: await head(work.work), scalarValue: { kind: 'unknown' },
    actingSubject: member.actor, idempotencyKey: randomUUID(),
  }); }, snapshot: () => snapshot(member, [work.work, work.mainVersion, structure.structure!, receipt]) };
}

async function replyCommand(): Promise<Scenario> {
  const member = await personFor(), work = await workFor(member), control = await controllerFor(member);
  await member.grant(`work:edit:${work.work}`, 'work.edit');
  const reply = `https://rezics.com/id/${randomUUID()}`;
  const input = { reply, variantId: `urn:rezics:variant:${randomUUID()}`,
    rootTarget: work.work, rootRevision: work.workRevision, language: 'en', direction: 'ltr' as const,
    expectedHead: null, body: 'Retained reply', actingSubject: member.actor };
  const key = randomUUID();
  let revision = '';
  return { command: async (fresh, changed) => {
    const result = await saveMemberReplyDraft(stack.env, stack.content, deps().account, stack.access,
      request(member), { ...input, ...(changed ? { body: 'Other binding' } : {}) }, fresh ? randomUUID() : key);
    revision ||= result.revisionId;
    return result;
  }, advance: async () => { await saveMemberReplyDraft(stack.env, stack.content, deps().account, stack.access,
    request(member), { ...input, expectedHead: revision, body: 'Advanced reply' }, randomUUID()); },
  lose: () => deactivateFixtureController(stack.accessPool, control), snapshot: () => snapshot(member, [work.work, reply, input.variantId]) };
}

async function creditRetirementCommand(): Promise<Scenario> {
  const member = await stack.member(randomUUID());
  await member.grant('work:create:root', 'work.create');
  const externalId = `OL${Math.floor(Math.random() * 900000000) + 100000000}W`;
  const raw = Buffer.from(JSON.stringify({ key: `/works/${externalId}`, type: { key: '/type/work' },
    title: 'Source credit evidence', revision: 1, authors: [{ author: { key: '/authors/OL1A' } }] }));
  const observed = await deps().sourceIntake!.submit(member.principalId, randomUUID(), {
    provider: 'open-library', namespace: 'work', externalId, sourceRevision: '1', mediaType: 'application/json',
    retention: 'retained', rawBytesBase64: raw.toString('base64'),
    coverage: { scope: 'open-library-work-response-v1', complete: true, omittedFields: [] },
    rightsEvidence: { basis: 'unknown', note: '' },
  }, { profile: 'open-library-work-acquisition-v1', url: `https://openlibrary.org/works/${externalId}.json`,
    status: 200, etag: null, lastModified: null, fetchedAt: new Date().toISOString() });
  const converted = await deps().sourceConversions!.convert(member.principalId, observed.observation.observation.slice(-36));
  if (!converted) throw new Error('Source credit setup has no conversion');
  await deps().sourceGraph!.project(member.principalId, converted.conversion.conversion.slice(-36));
  const proposed = await deps().sourceProposals!.propose(member.principalId, converted.conversion.conversion.slice(-36));
  if (!proposed) throw new Error('Source credit setup has no proposal');
  const adoptions = new SourceNativeWorkAdoptionStore(stack.contentPool, deps().sourceProposals!,
    stack.env, deps().account, stack.access);
  const bound = await adoptions.adopt(member.principalId, request(member), proposed.proposal.proposal.slice(-36), {
    actingSubject: member.actor, authorityPath: 'represented-agent', confirmedTitle: 'Source credit evidence',
  });
  if (!bound) throw new Error('Source credit setup has no native Work binding');
  const work = bound.adoption;
  const grant = await member.grant(`work:edit:${work.work}`, 'work.edit');
  await member.grant(`work:read:${work.work}`, 'work.read');
  const credits = new SourceAuthorCreditStore(stack.contentPool, deps().sourceProposals!, deps().sourceConversions!,
    deps().sourceCorrespondences!, stack.env, deps().account, stack.access);
  const adopted = await credits.adopt(await principal(member), member.principalId, request(member),
    work.work, randomUUID(), { proposal: proposed.proposal.proposal, conversion: converted.conversion.conversion,
      occurrence: sourceChildOccurrence(observed.observation.observation, 'authors', 0), sourceOrdinal: 0,
      confirmedSourceKey: '/authors/OL1A', confirmedRoleKey: null, nativeOrdinal: 0,
      expectedHead: work.workRevision, actingSubject: member.actor, baseSupport: null, correspondence: null,
      confirmedUse: 'factual-reference-only' });
  if (!adopted) throw new Error('Source credit setup has no native receipt');
  const credit = adopted.support.credit;
  const input = { work: work.work, credit: credit.credit, revision: credit.revision, expectedHead: work.workRevision,
    reason: 'Superseded author attribution', actingSubject: member.actor, idempotencyKey: randomUUID() };
  let receipt = '';
  return { command: async (fresh, changed) => {
    const result = await retireAuthorCredit(stack.env, deps().account, stack.access, request(member), {
      ...input, ...(fresh ? { idempotencyKey: randomUUID() } : {}), ...(changed ? { reason: 'Other binding' } : {}),
    });
    receipt ||= result.retirement.retirement;
    return result;
  }, lose: loss => grantLoss(member, grant, loss),
  advance: async () => { await editAdmittedMetadataWork(stack.env, deps().account, stack.access, request(member), {
    work: work.work, expectedHead: await head(work.work), title: 'Credit Work after title edit',
    titleControl: (await readTitleControl(stack.env, work.work)).basis,
    actingSubject: member.actor, idempotencyKey: randomUUID(),
  }); }, snapshot: () => snapshot(member, [work.work, credit.credit, credit.revision, receipt]) };
}

async function identificationCommand(): Promise<Scenario> {
  const member = await stack.member(randomUUID());
  const book = await workFor(member, ['https://schema.org/Book']);
  const target = await workFor(member, ['https://schema.org/Book']);
  const bookGrant = await member.grant(`work:edit:${book.work}`, 'work.edit');
  await member.grant(`work:read:${book.work}`, 'work.read');
  await member.grant(`work:edit:${target.work}`, 'work.edit');
  await member.grant(`work:edit:${target.work}`, 'relation.change');
  let definition = await readDefinitionByKey(stack.env, 'composition-part', systemDisclosure);
  if (!definition) {
    await member.grant('semantic:create:root', 'semantic.change');
    await admittedSemanticChange(stack.env, deps().account, stack.access, request(member), {
      expectedHead: null, actingSubject: member.actor, idempotencyKey: randomUUID(),
      state: { component: 'definition', kind: 'relation', notation: 'composition-part', workSubjectRole: 'part',
        roles: ['whole', 'part'].map(key => ({ key, minParticipants: 1, maxParticipants: 1, ordered: false })) },
    });
    definition = await readDefinitionByKey(stack.env, 'composition-part', systemDisclosure);
  }
  if (!definition) throw new Error('Post setup has no composition-part definition');
  await member.grant(`semantic:read:${definition.definition}`, 'semantic.read');
  const structure = await createAdmittedComposition(stack.env, deps().account, stack.access, request(member), {
    profile: 'book-composition', work: book.work, mainVersion: book.mainVersion,
    actingSubject: member.actor, idempotencyKey: randomUUID(),
  });
  if (!structure.structure || !structure.revision) throw new Error('Post setup has no composition receipt');
  const seed = randomUUID();
  const chapter = { work: derivedId(`${seed}:post`), mainVersion: derivedId(`${seed}:main`),
    workRevision: derivedId(`${seed}:revision`), mainRevision: derivedId(`${seed}:main-revision`),
    title: 'Retained chapter', language: 'en', direction: 'ltr' as const };
  const placed = await changeAdmittedComposition(stack.env, deps().account, stack.access, request(member), {
    structure: structure.structure, expectedHead: structure.revision, actingSubject: member.actor, idempotencyKey: randomUUID(),
    operations: [{ op: 'insert', parent: structure.structure, position: 'last', role: 'chapter', target: chapter.work,
      label: { value: chapter.title, language: chapter.language } }], newWork: chapter,
  });
  if (!placed.revision || !placed.occurrences?.[0]) throw new Error('Post setup has no occurrence receipt');
  const postGrant = await member.grant(`work:edit:${chapter.work}`, 'work.edit');
  await member.grant(`work:read:${chapter.work}`, 'work.read');
  // An existing identification reuses one exact realization. Prepare that
  // realization lawfully so immediate replay preserves the same receipt tuple.
  const realization = await createAdmittedComposition(stack.env, deps().account, stack.access, request(member), {
    profile: 'book-composition', work: target.work, mainVersion: target.mainVersion,
    actingSubject: member.actor, idempotencyKey: randomUUID(),
  });
  if (!realization.structure || !realization.revision) throw new Error('Identification setup has no realization');
  await changeAdmittedComposition(stack.env, deps().account, stack.access, request(member), {
    structure: realization.structure, expectedHead: realization.revision, actingSubject: member.actor, idempotencyKey: randomUUID(),
    operations: [{ op: 'insert', parent: realization.structure, position: 'last', role: 'chapter', target: chapter.work }],
  });
  const input = { profile: 'post-identification-v1', placement: { book: book.work, occurrence: placed.occurrences[0] },
    work: { kind: 'existing', id: target.work }, actingSubject: member.actor,
    evidence: { kind: 'independent-citation', source: { kind: 'citation', value: 'Retained anthology, chapter 1' } } };
  const key = randomUUID();
  let receipt = '';
  return { command: async (fresh, changed) => {
    const result = await identifyPost(deps(), request(member), chapter.work, { ...input,
      ...(changed ? { evidence: { kind: 'standalone-title' } } : {}),
    }, fresh ? randomUUID() : key);
    receipt ||= result.receipt;
    return result;
  }, lose: async loss => { await grantLoss(member, bookGrant, loss); await grantLoss(member, postGrant, loss); },
  snapshot: () => snapshot(member, [book.work, target.work, chapter.work, structure.structure!, realization.structure!, receipt]) };
}

export const entries: ReplayEntry[] = [
  admittedEntry('POST /v1/content-edits', 'Content title edits', 'modules/work/edit-admitted.ts#editAdmittedMetadataWork',
    'work:edit:{work}', 'work.edit', () => workEdit('title-control')),
  admittedEntry('PUT /v1/works/{}/metadata', 'Work metadata edits', 'modules/work/metadata-command.ts#setWorkMetadata',
    'work:edit:{work}', 'work.edit', () => workEdit('metadata')),
  admittedEntry('PUT /v1/works/{}/type', 'Work type edits', 'modules/work/type-command.ts#stateWorkType',
    'work:edit:{work}', 'work.edit', () => workEdit('type')),
  admittedEntry('POST /v1/works/{}/scalar-value', 'Work scalar edits', 'modules/work/edit-admitted.ts#setAdmittedWorkScalar',
    'work:edit:{work}', 'work.edit', () => workEdit('scalar')),
  admittedEntry('POST /v1/contributions', 'Contribution creation', 'modules/contribution/create-admitted.ts#createAdmittedTextContribution',
    'contribution:create:{work}', 'contribution.create', () => contributionCommand('create')),
  admittedEntry('POST /v1/contribution-edits', 'Contribution edits', 'modules/contribution/edit-admitted.ts#editAdmittedTextContribution',
    'contribution:edit:{contribution}', 'contribution.edit', () => contributionCommand('edit')),
  admittedEntry('POST /v1/contribution-publications', 'Contribution publication', 'modules/contribution/publish-admitted.ts#publishAdmittedTextContribution',
    'contribution:publish:{contribution}', 'contribution.publish', () => contributionCommand('publish')),
  admittedEntry('POST /v1/content-drafts', 'Content draft saves', 'modules/content-publication/draft.ts#saveAdmittedContentDraft',
    'content:draft:{work}', 'content.draft', () => contentCommand('draft')),
  admittedEntry('POST /v1/content-comments', 'Content comments', 'modules/content-publication/comment.ts#createAdmittedContentComment',
    'content:comment:{work}', 'content.comment', () => contentCommand('comment')),
  admittedEntry('POST /v1/content-publications', 'Content publication', 'modules/content-publication/publish-admitted.ts#publishAdmittedContent',
    'content:publish:{work}', 'content.publish', () => contentCommand('publish')),
  admittedEntry('POST /v1/content-search-eligibility', 'Content search eligibility', 'modules/content-publication/eligibility-admitted.ts#selectAdmittedPublicContentSearch',
    'content:search-eligibility:{work}', 'content.search-eligibility', () => contentCommand('eligibility')),
  editorialEntry('POST /v1/editorial/proposals', 'create', 'controller'),
  editorialEntry('POST /v1/editorial/proposals/{}/revisions', 'revise', 'controller'),
  editorialEntry('POST /v1/editorial/proposals/{}/withdrawal', 'withdraw', 'controller'),
  editorialEntry('POST /v1/editorial/proposals/{}/reviews', 'review', 'controller'),
  editorialEntry('POST /v1/editorial/proposals/{}/reviews', 'review', 'domain-grant'),
  editorialEntry('POST /v1/editorial/proposals/{}/decisions', 'decide', 'controller'),
  editorialEntry('POST /v1/editorial/proposals/{}/decisions', 'decide', 'domain-grant'),
  editorialEntry('POST /v1/editorial/proposals/{}/reversal', 'revert', 'controller'),
  admittedEntry('POST /v1/resources/{}/derivations', 'Work derivation declarations', 'modules/work/derivations.ts#createAdmittedWorkDerivation',
    'derivation:link:{work}', 'work.derive', () => derivationCommand()),
  {
    ...admittedEntry('POST /v1/publication-selections', 'Publication selections', 'modules/work/select-main-admitted.ts#selectAdmittedMainDefault',
      'publication:select:{main} or publication:adopt:{realm}', 'publication.select or publication.adopt',
      subcase => publicationCommand(subcase), ['main', 'realm']),
    owners: ['modules/work/select-main-admitted.ts#selectAdmittedMainDefault', 'modules/work/select-realm-admitted.ts#selectAdmittedRealmLocal'],
  },
  admittedEntry('POST /v1/publication-rejections', 'Realm publication rejections', 'modules/work/reject-realm-admitted.ts#rejectAdmittedRealmLocal',
    'publication:reject:{realm}', 'publication.reject', () => publicationCommand('reject')),
  { ...admittedEntry('PUT /v1/realms/{}/main-versions/{}/variant-recommendation', 'Realm variant recommendations',
    'modules/work/realm-variant-recommendation.ts#RealmVariantRecommendationStore.set',
    'publication:adopt:{realm}', 'publication.adopt', () => recommendationCommand()),
    conflict: RealmVariantRecommendationConflict, registration: 'turned' },
  { operation: 'POST /v1/work-maintainer-changes', family: 'Work maintainer changes',
    authorityClass: 'controller', scope: 'Work maintainer Agent', action: 'agent.control',
    owners: ['modules/work/maintainers.ts#WorkMaintainers.change'], subcases: ['add', 'transfer', 'remove'],
    losses: ['revoked'], denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'registered-failing',
    requestBuilder: subcase => maintainerCommand(subcase) },
  admittedEntry('POST /v1/work-publications', 'Structured Work publication',
    'modules/work/structured-publication-admitted.ts#changeAdmittedWorkStructurePublication',
    'work:publish:{work}', 'work.publish or work.withdraw-publication',
    subcase => structurePublicationCommand(subcase), ['publish', 'withdraw']),
  { ...admittedEntry('POST /v1/member-reply-drafts', 'Member reply drafts', 'modules/content-publication/reply-draft.ts#saveMemberReplyDraft',
    'content:draft:{reply}', 'content.draft', () => replyCommand()), authorityClass: 'controller', losses: ['revoked'] },
  admittedEntry('POST /v1/works/{}/author-credits/{}/retirements', 'Native author credit retirements',
    'modules/work/author-credit-retirement.ts#retireAuthorCredit', 'work:edit:{work}', 'work.edit', () => creditRetirementCommand()),
  { ...admittedEntry('POST /v1/posts/{}/identifications', 'Post identification', 'modules/post/identification.ts#identifyPost',
    'work:edit:{post} or work:edit:{book}', 'work.edit', () => identificationCommand()), registration: 'turned',
    subcases: ['existing realization'] },
];

export const area = "editorial";
export const moduleOwners = ["work", "content-publication", "editorial-review", "contribution", "post"];
export const replayEntries = entries;
export const coveredOperations = [...new Set(replayEntries.map(entry => entry.operation))];
export const uncoveredOperations: string[] = [
  // Fresh reference resolution takes no idempotency key and retains no saved result.
  // The tracer reaches the generic owner helper through the live Zone content.draft
  // authority check; tests/qa/integration/content-adoption.test.ts witnesses public
  // resolution and private/successor refusal. Keep this trace named without claiming
  // command replay coverage.
  "POST /v1/resource-reference-resolutions",
  // This keyed saved-result owner requires only an active Account principal.
  // The accepted controller/domain-grant reducers cannot make it refuse;
  // retain the gap until the shared contract can execute that authority class.
  "PUT /v1/me/main-versions/{}/variant-preference",
];
