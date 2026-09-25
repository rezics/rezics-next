import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AccessAdmissionRegistry, type ClaimedAdmission, type VerifiedPrincipal }
  from '../../services/main/src/modules/access/admission.ts';
import { activateMetadataWork, ID, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../services/main/src/modules/work/activate.ts';
import { activateTextContribution, textContributionDigest }
  from '../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../services/main/src/modules/contribution/publish.ts';
import { createRealmSpace, spaceCreationDigest } from '../../services/main/src/modules/space/create.ts';
import { selectMainDefault, mainSelectionDigest } from '../../services/main/src/modules/work/select-main.ts';
import { selectRealmLocal, realmSelectionDigest } from '../../services/main/src/modules/work/select-realm.ts';
import { rejectRealmLocal, realmRejectionDigest } from '../../services/main/src/modules/work/reject-realm.ts';
import { createRatingContext, ratingContextDigest } from '../../services/main/src/modules/rating/context.ts';
import { seedContent, type LoadCase } from '../../tests/qa/load/corpus.ts';
import { onceForKey, runBoundedIndices } from './schedule.ts';

export function uniqueToken(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 26 ** 4)
    throw new Error('load index outside four-letter token space');
  let value = index;
  let letters = '';
  for (let i = 0; i < 4; i++) { letters = String.fromCharCode(97 + value % 26) + letters; value = Math.floor(value / 26); }
  return `loadtoken${letters}`;
}

export function selectedBody(token: string, iteration: number): string {
  if (!/^loadtoken[a-z]{4}$/.test(token) || !Number.isInteger(iteration) || iteration < 0)
    throw new Error('invalid mixed selection body');
  return `${token} public load corpus refreshmarker${iteration}`;
}

export function replacementContribution(item: { work: string; token: string; language: string },
  iteration: number) {
  return { work: item.work, language: item.language, body: selectedBody(item.token, iteration) };
}

/** Deterministic half-hot writer allocation; the 10-Work diagnostic has no writable hot Work. */
export function writerCohorts(indices: number[], hotCount: number) {
  return { hot: indices.filter(index => index < hotCount),
    cold: indices.filter(index => index >= hotCount) };
}

export function writerIndex(cohorts: ReturnType<typeof writerCohorts>, iteration: number) {
  const { hot, cold } = cohorts;
  const chooseHot = hot.length > 0 && (cold.length === 0
    || (iteration + Math.floor(iteration / 20)) % 2 === 0);
  const lane = chooseHot ? hot : cold;
  if (!lane.length) throw new Error('No writable Work in load writer cohort');
  return { index: lane[Math.floor(iteration / (hot.length && cold.length ? 2 : 1)) % lane.length]!,
    hot: chooseHot };
}

interface Terminal {
  outcome?: 'succeeded' | 'cancelled'; receipt: string; dataEpoch: string; sequence: string;
}

/** Grants and claims every seed command against the real Access ledger. */
export class LoadAuthority {
  readonly actor = ID + randomUUID();
  readonly principal: VerifiedPrincipal = { issuer: 'https://qa-load-local.test', subject: randomUUID() };
  readonly access: AccessAdmissionRegistry;
  private readonly principalId = randomUUID();
  private readonly granted = new Map<string, Promise<void>>();
  private readonly represented = new Map<string, Promise<void>>();

  constructor(private readonly pool: Pool) { this.access = new AccessAdmissionRegistry(pool); }

  async initialize(): Promise<void> {
    await this.pool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [this.principalId, this.principal.issuer, this.principal.subject]);
    await this.pool.query('INSERT INTO access.authority_subject (id, kind) VALUES ($1, $2)', [this.actor, 'agent']);
  }

  private async grant(scope: string, action: string): Promise<void> {
    await onceForKey(this.represented, action, async () => {
      await this.pool.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, $4, now() + interval '6 hours')`,
      [randomUUID(), this.principalId, this.actor, action]);
    });
    const key = `${scope}\0${action}`;
    await onceForKey(this.granted, key, async () => {
      await this.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [scope]);
      await this.pool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $2, $3, $4, now() + interval '6 hours')`,
      [randomUUID(), this.actor, scope, action]);
    });
  }

  async run<T extends Terminal>(scope: string, action: string, digest: string,
    execute: (admission: ClaimedAdmission) => Promise<T>): Promise<T> {
    await this.grant(scope, action);
    const registered = await this.access.register({ principal: this.principal,
      actingSubject: this.actor, scope, action, idempotencyKey: `load-${randomUUID()}`,
      requestDigest: digest });
    const claimed = await this.access.claim(registered.id, digest);
    const result = await execute(claimed);
    if (result.outcome && result.outcome !== 'succeeded') throw new Error(`${action} returned ${result.outcome}`);
    await this.access.recordGraphOutcome(claimed.id, { outcome: 'succeeded', receipt: result.receipt,
      admissionId: claimed.id, requestDigest: digest, authorityEpoch: claimed.authorityEpoch,
      scope, dataEpoch: result.dataEpoch, sequence: result.sequence });
    return result;
  }
}

export interface PracticalCorpus {
  realm: string;
  ratingContext: string;
  works: { work: string; main: string; head: string; selection: string;
    createReceipt: string; selectionReceipt: string; editReceipt?: string;
    token: string; language: string }[];
  mainUnits: number;
  contentUnits: number;
  cases: LoadCase[];
}

export async function seedPracticalCorpus(env: WorkActivationEnvironment, contentPool: Pool,
  accessPool: Pool, count: number, progress: (completed: number) => void,
  workers = 1, startIndex = 0): Promise<{
    corpus: PracticalCorpus; authority: LoadAuthority }> {
  if (!Number.isInteger(count) || count < 10 || count > 10_000
    || !Number.isInteger(startIndex) || startIndex < 0 || startIndex + count > 10_000) {
    throw new Error('practical corpus requires 10–10000 Works within the load token range');
  }
  const authority = new LoadAuthority(accessPool);
  await authority.initialize();
  const actor = authority.actor;
  const spaceInput = { name: 'Practical Load Realm', actingSubject: actor };
  const space = await authority.run('space:create:root', 'space.create', spaceCreationDigest(spaceInput),
    admission => createRealmSpace(env, admission, spaceInput));
  if (!space.realm) throw new Error('Realm creation lacks an ID');
  const ratingInput = { realm: space.realm, question: 'Practical standing rating', actingSubject: actor };
  const rating = await authority.run(`rating:context:${space.realm}`, 'rating.context.create',
    ratingContextDigest(ratingInput), admission => createRatingContext(env, admission, ratingInput));
  if (!rating.context) throw new Error('Rating context lacks an ID');
  const works = new Array<PracticalCorpus['works'][number]>(count);
  const published = new Array<{ contribution: string; decision: string }>(count);
  const contribution = async (work: string, body: string, language: string) => {
    const input = { work, language, body, actingSubject: actor };
    const draft = await authority.run(`contribution:create:${work}`, 'contribution.create',
      textContributionDigest(input), admission => activateTextContribution(env, admission, input));
    if (!draft.contribution || !draft.draftRevision) throw new Error('Contribution draft lacks an exact revision');
    const publication = { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
      disclosure: 'public' as const, actingSubject: actor };
    const decision = await authority.run(`contribution:publish:${draft.contribution}`,
      'contribution.publish', textPublicationDigest(publication),
      admission => publishTextContribution(env, admission, publication));
    if (!decision.publicationDecision) throw new Error('Contribution publication lacks a decision');
    return { contribution: draft.contribution, decision: decision.publicationDecision };
  };
  await runBoundedIndices(count, workers, async index => {
    const globalIndex = startIndex + index;
    const token = uniqueToken(globalIndex);
    const title = `Load Work ${globalIndex}`;
    const created = await authority.run('work:create:root', 'work.create',
      metadataWorkRequestDigest(title), admission => activateMetadataWork(env, { title, admission }));
    const language = globalIndex % 101 === 7 ? 'zh' : globalIndex % 137 === 9 ? 'ja' : 'en';
    const draft = await contribution(created.work, `${token} public load corpus`, language);
    const input = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
      work: created.work, contribution: draft.contribution, publicationDecision: draft.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: actor };
    const selected = await authority.run(`publication:select:${created.mainVersion}`,
      'publication.select', mainSelectionDigest(input),
      admission => selectMainDefault(env, admission, input));
    if (!selected.selection) throw new Error('Main selection lacks a head');
    works[index] = { work: created.work, main: created.mainVersion, head: created.workRevision,
      selection: selected.selection, createReceipt: created.receipt,
      selectionReceipt: selected.receipt, token, language };
    published[index] = draft;
  }, progress);
  const adopted = await contribution(works[1]!.work, 'realm violet harbor', 'en');
  const adoptionInput = { context: { kind: 'realm-local' as const, id: space.realm },
    work: works[1]!.work, mainVersion: works[1]!.main, contribution: adopted.contribution,
    publicationDecision: adopted.decision, expectedSelectionHead: null,
    selectionBasis: 'realm-manager-review' as const, actingSubject: actor };
  await authority.run(`publication:adopt:${space.realm}`, 'publication.adopt',
    realmSelectionDigest(adoptionInput), admission => selectRealmLocal(env, admission, adoptionInput));
  const rejected = await contribution(works[2]!.work, 'rejected sapphire harbor', 'en');
  const rejectionInput = { context: { kind: 'realm-local' as const, id: space.realm },
    work: works[2]!.work, mainVersion: works[2]!.main, expectedSelectionHead: null,
    decisionBasis: 'realm-manager-review' as const, reasonCode: 'not-approved' as const,
    actingSubject: actor };
  await authority.run(`publication:reject:${space.realm}`, 'publication.reject',
    realmRejectionDigest(rejectionInput), admission => rejectRealmLocal(env, admission, rejectionInput));
  await seedContent(env, contentPool, accessPool, works[0]!.work);
  const cases: LoadCase[] = [
    { name: 'hot-main', lane: 'main', phrase: works[0]!.token, language: 'en', expectedWork: works[0]!.work },
    { name: 'other-main', lane: 'main', phrase: works[3]!.token, language: 'en', expectedWork: works[3]!.work },
    { name: 'chinese-main', lane: 'main', phrase: works[7]!.token, language: 'zh', expectedWork: works[7]!.work },
    { name: 'realm-adoption', lane: 'realm', phrase: 'realm violet harbor', language: 'en',
      expectedWork: works[1]!.work, expectedContribution: adopted.contribution,
      expectedReason: 'realm-adoption' },
    { name: 'realm-fallback', lane: 'realm', phrase: works[3]!.token, language: 'en',
      expectedWork: works[3]!.work, expectedContribution: published[3]!.contribution,
      expectedReason: 'main-fallback' },
    { name: 'rejected-candidate', lane: 'realm', phrase: 'rejected sapphire harbor', language: 'en',
      expectedWork: null },
    { name: 'content', lane: 'content', phrase: 'exact content beacon', language: 'en',
      expectedWork: works[0]!.work },
  ];
  return { corpus: { realm: space.realm, ratingContext: rating.context, works,
    mainUnits: count + 1, contentUnits: 1, cases }, authority };
}
