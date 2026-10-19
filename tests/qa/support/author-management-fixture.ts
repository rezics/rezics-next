import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fromPlainText } from '@rezics/document';
import { readEnv } from '../../../scripts/dev/config.ts';
import { FixtureWorkBudget } from '../../../scripts/fixture/budget.ts';
import { sha256, stable } from '../../../scripts/fixture/corpus.ts';
import type { RetainedJson, RetainedOwnerState } from '../../../scripts/fixture/manifest.ts';
import { recordRetainedPostgresCollations } from '../../../scripts/fixture/runtime-facts.ts';
import { dockerEnvironment, postgresImage, projectRunning, removeStoppedContainers, removeVolumes,
  root, run, stream, VOLUME_KINDS } from '../../../scripts/fixture/stack.ts';
import { loadCompatibility } from '../../../scripts/load/compatibility.ts';
import { retainStoppedOwnerBackup, restoreCatalogueBackup } from '../../../scripts/load/catalogue-backup.ts';
import { stopCorpusSourcePostgres } from '../../../scripts/load/corpus-backup-driver.ts';
import { RetainedSources, sourceFileDigests, sourceKey, type RetainedSourceAdapter,
  type SourceContext, type SourceInputs } from '../../../scripts/qa/retained-source.ts';
import { retainedVolumeInventory } from '../../../scripts/qa/retained-volume.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { boundedPool } from '../../../services/main/src/infrastructure/pg-pool.ts';
import { auditBaseline } from '../fixtures/audit-corpus-contract.ts';
import { grantPersonaFixtureAuthority } from './persona-fixture-authority.ts';
import { assertAuditExecution, type AuditExecutionMetadata } from './audit-execution.ts';
import { personaSessions, retainPersonaRealm, restorePersonaRealms,
  type PersonaSession, type PersonaSessions, type RetainedPersonaRealm } from './personas.ts';

export const short = (value: string) => value.slice(-36);
export const bookType = 'https://schema.org/Book';
export const actorQuery = (person: PersonaSession) => new URLSearchParams(
  person.actingSubject ? { actingSubject: person.actingSubject } : {});
export type Work = { work: string; mainVersion: string; workRevision: string; title: string };
export type Content = { resourceId: string; variantId: string; revisionId: string;
  byteDigest: string; sourcePosition: { dataEpoch: string }; publication: string;
  eligibility: string; body: string };
export type Reply = { reply: string; variantId: string; revisionId: string; revisionDigest: string;
  author: string; rootTarget: string; rootRevision: string; body: string; placement: string };
type Composition = { structure: string; revision: string; occurrences: string[] };
export type AuthorManagementCorpus = {
  format: 'author-management-corpus-v1'; baselineProduct: string; buildHead: string;
  execution: AuditExecutionMetadata;
  compatibility: string; recipeDigest: string; backup: string; preparedMs: number;
  realms: [RetainedPersonaRealm, RetainedPersonaRealm];
  inventory: { matching: Work[]; draft: Work; otherType: Work; foreign: Work;
    alternateAgent: string; alternate: Work; edited: string };
  book: Work; composition: Composition; chapterOccurrence: string;
  group: string; chapterGroup: string; chapterCount: number;
  chapter: Content; chapterWorkRevision: string; post: Content; postWorkRevision: string;
  adoption: { work: Work; structure: string; revision: string; publication: string };
  reply: Reply; independentPlacement: string; independentReply: Reply;
};
const directory = resolve(root, '.temp/author-management-corpus');
export const authorManagementManifest = join(directory, 'retained.json');
const sourceDirectory = join(directory, 'sources');
const sources = new RetainedSources(sourceDirectory);
const backupIdentity = (key: string) => `author-${sha256(stable([root, key])).slice(0, 48)}`;
const recipeDigest = () => {
  const digest = createHash('sha256');
  for (const file of ['./author-management-fixture.ts', './personas.ts', './persona-fixture-authority.ts'])
    digest.update(file).update(readFileSync(new URL(file, import.meta.url)));
  return digest.digest('hex');
};

/** A generation is published by RetainedSources, with actual recipe/product
 * inputs and stopped-owner custody; the historical audit baseline is separate. */
export function authorManagementSourceInputs(productRevision: string): SourceInputs {
  if (!/^[a-f0-9]{40}$/.test(productRevision)) throw new Error('Pin the actual author-management product revision');
  const files = execFileSync('git', ['ls-files', '-z', '--', 'apps', 'packages', 'services', 'model', 'infra',
    'generated', 'yarn.lock', 'package.json', 'scripts/fixture', 'scripts/load',
    'scripts/qa/retained-source.ts', 'scripts/qa/retained-volume.ts', 'scripts/qa/volume-inventory.ts',
    'tests/qa/support/author-management-fixture.ts', 'tests/qa/support/personas.ts',
    'tests/qa/support/persona-fixture-authority.ts'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  // The helper can be newly enrolled before its first commit, while generation
  // admission itself still requires the committed clean proof checkout.
  files.push('tests/qa/support/author-management-fixture.ts');
  return { producer: 'author-management', version: '1', files: sourceFileDigests(root, files),
    inputs: { corpusOrigin: 'public-api-command-created', contract: 'author-management-corpus-v1', productRevision },
    compatibility: JSON.parse(stable({ storage: loadCompatibility(root), postgres: postgresImage() })) as RetainedOwnerState };
}

type RestoredAuthor = Awaited<ReturnType<typeof restoreAuthorCopy>>;
type AuthorBuild = RetainedSourceAdapter<RetainedJson, RestoredAuthor>['build'];
function authorSourceAdapter(specification: SourceInputs, build?: AuthorBuild): RetainedSourceAdapter<RetainedJson, RestoredAuthor> {
  return { specification,
    async build(context) {
      if (!build) throw new Error('Author-management restore cannot prepare a source');
      return build(context);
    },
    async verify(context, manifest) {
      const metadata = manifest.metadata as unknown as AuthorManagementCorpus;
      const backup = JSON.parse(readFileSync(join(context.backup, 'owners/backup.json'), 'utf8')) as {
        project: string; compatibility: { digest: string } };
      const state = manifest.integrity.ownerState;
      const expected = `-${backupIdentity(context.key)}-`;
      if (!backup.project.startsWith('rezics-catalogue-corpus-') || !backup.project.includes(expected)
        || state.project !== backup.project) return ['Author backup physical project differs from this checkout/generation'];
      if (metadata.recipeDigest !== recipeDigest() || metadata.compatibility !== loadCompatibility(root).digest
        || backup.compatibility.digest !== metadata.compatibility || metadata.preparedMs > 600_000
        || metadata.execution.fixtureGeneration !== context.key
        || metadata.baselineProduct !== specification.inputs.productRevision
        || metadata.execution.productRevision !== metadata.baselineProduct
        || metadata.backup !== join(sourceDirectory, context.key, 'backup/owners/backup.json'))
        return ['Author recipe, product, storage, preparation or generation differs'];
      const docker = dockerEnvironment(), evidence: string[] = [];
      if (projectRunning(backup.project, docker)) evidence.push('Author retained backup is running');
      const saved = state.volumes as RetainedOwnerState;
      for (const kind of VOLUME_KINDS) {
        if (stable(retainedVolumeInventory(`${backup.project}_${kind}`, docker)) !== stable(saved[kind]))
          evidence.push(`Author retained ${kind} inventory differs`);
        context.budget.remaining();
      }
      return evidence;
    },
    restore: (context, manifest) => restoreAuthorCopy(manifest.metadata as unknown as AuthorManagementCorpus, context.budget),
    dispose: candidate => candidate.close(),
    async remove(key) {
      if (!/^rs-author-management-[a-f0-9]{64}$/.test(key)) throw new Error('Refuse another producer namespace');
      const pattern = new RegExp(`^(rezics-catalogue-corpus-[a-z0-9][a-z0-9-]{0,30}-${backupIdentity(key)}-[a-f0-9]{16})_(?:postgres_data|fuseki_data|rustfs_data)$`);
      const docker = dockerEnvironment(), projects = new Map<string, string[]>();
      for (const volume of run('docker', ['volume', 'ls', '-q'], docker).trim().split('\n')) {
        const match = pattern.exec(volume);
        if (match) projects.set(match[1]!, [...projects.get(match[1]!) ?? [], volume]);
      }
      for (const [project, volumes] of projects) {
        if (projectRunning(project, docker)) throw new Error('Refuse removal of a running author backup');
        removeStoppedContainers(project, docker); removeVolumes(volumes, docker);
      }
    },
  };
}

/** Setup errors stay outside persona bodies and cannot be reported as product failures. */
export async function fixtureAnswer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, raw = await response.text();
  if (response.status !== status) throw new Error(
    `Author-management fixture expected ${status}, got ${response.status}: ${raw}`);
  return JSON.parse(raw) as T;
}
async function createWork(person: PersonaSession, title: string, type = bookType): Promise<Work> {
  return { ...await fixtureAnswer<Omit<Work, 'title'>>(person.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title, language: 'en', semanticTypes: [type],
    authoring: 'own-work', actingSubject: person.actingSubject,
  }), 201), title };
}
async function publishBook(person: PersonaSession, book: Work) {
  const contribution = await fixtureAnswer<{ contribution: string; draftRevision: string }>(
    person.main('POST', '/v1/contributions', { profile: 'text-contribution-v1', work: book.work,
      language: 'en', body: 'An original field notebook about a garden.', actingSubject: person.actingSubject }), 201);
  const publication = await fixtureAnswer<{ publicationDecision: string }>(
    person.main('POST', '/v1/contribution-publications', { profile: 'text-publication-v1',
      contribution: contribution.contribution, expectedDraftHead: contribution.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: person.actingSubject }), 201);
  await fixtureAnswer(person.main('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', work: book.work, contribution: contribution.contribution,
    publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
    context: { kind: 'main-version-default', id: book.mainVersion }, selectionBasis: 'main-maintainer',
    actingSubject: person.actingSubject,
  }), 201);
}
export async function publishContent(person: PersonaSession, draft: Omit<Content, 'publication' | 'eligibility' | 'body'>,
  publicationHead: string | null = null, eligibilityHead: string | null = null) {
  const publication = await fixtureAnswer<{ decision: string; status: string }>(person.main('POST',
    '/v1/content-publications', { profile: 'content-publication-v1', resourceId: draft.resourceId,
      variantId: draft.variantId, revisionId: draft.revisionId, preparationId: randomUUID(),
      expectedDigest: draft.byteDigest, expectedContentEpoch: draft.sourcePosition.dataEpoch,
      expectedPublicationHead: publicationHead, actingSubject: person.actingSubject }), 201);
  if (publication.status !== 'active') throw new Error('Fixture publication is not active');
  const eligibility = await fixtureAnswer<{ decision: string }>(person.main('POST', '/v1/content-search-eligibility', {
    profile: 'content-search-eligibility-v1', resourceId: draft.resourceId, variantId: draft.variantId,
    publicationDecision: publication.decision, expectedEligibilityHead: eligibilityHead,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: person.actingSubject,
  }), 201);
  return { publication: publication.decision, eligibility: eligibility.decision };
}
async function originalContent(person: PersonaSession, resourceId: string, variantId: string, body: string,
  saved?: { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }): Promise<Content> {
  const draft = saved ?? await fixtureAnswer<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(
    person.main('POST', '/v1/content-drafts', { profile: 'content-text-v1', resourceId, variantId,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', expectedHead: null,
      body, actingSubject: person.actingSubject }), 201);
  const content = { ...draft, resourceId, variantId };
  const qualified = await publishContent(person, content);
  const read = await fixtureAnswer<{ reference: { resourceId: string }; body: unknown }>(
    person.main('GET', `/v1/content-revisions/${draft.revisionId}`));
  if (read.reference.resourceId !== resourceId || read.body === null) throw new Error('Fixture exact revision is missing');
  return { ...content, ...qualified, body };
}
async function originalReply(person: PersonaSession, book: Work, realm: string, body: string): Promise<Reply> {
  const reply = `https://rezics.com/id/${randomUUID()}`, variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await fixtureAnswer<{ revisionId: string; revisionDigest: string }>(
    person.main('POST', '/v1/member-reply-drafts', { profile: 'member-reply-draft-v1', reply,
      variantId, rootTarget: book.work, rootRevision: book.workRevision, originRealm: null,
      language: 'en', direction: 'ltr', expectedHead: null, body, actingSubject: person.actingSubject }), 201);
  await fixtureAnswer(person.main('POST', '/v1/realm-replies', { profile: 'realm-reply-identity-v1',
    reply, variantId, revisionId: draft.revisionId, author: person.actingSubject,
    rootTarget: book.work, rootRevision: book.workRevision, parentReply: null,
    parentRevision: null, contextRevision: null }), 201);
  const placement = await fixtureAnswer<{ placement: string }>(person.main('POST', '/v1/realm-reply-placements', {
    profile: 'realm-reply-placement-v1', realm, reply, revisionId: draft.revisionId,
    revisionDigest: draft.revisionDigest, reviewDecisionId: null, expectedHead: null,
    actingSubject: person.actingSubject }), 201);
  return { ...draft, reply, variantId, author: person.actingSubject!, rootTarget: book.work,
    rootRevision: book.workRevision, body, placement: placement.placement };
}

/** Explicit producer mode; ordinary proofs only restore the same stopped all-owner cut. */
export async function buildAuthorManagementCorpus(): Promise<void> {
  if (!Bun.env.REZICS_QA_RUN_ID || Bun.env.AUTHOR_MANAGEMENT_PREPARE !== '1')
    throw new Error('Prepare only through the named isolated QA selection with AUTHOR_MANAGEMENT_PREPARE=1');
  if (existsSync(authorManagementManifest)) throw new Error('Retained corpus exists; reuse it without rebuilding');
  const compose = readEnv(join(root, '.temp/stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`, 'compose.env'));
  if (compose.REZICS_STACK_STORAGE !== 'persistent' || compose.REZICS_STACK_RAW_UPDATE !== '0')
    throw new Error('Enroll both author-management prove files in commandOnlyIntegrationFiles before preparing '
      + 'a persistent corpus with the closed product assembler');
  const baselineProduct = Bun.env.AUTHOR_MANAGEMENT_BASELINE;
  if (!baselineProduct || !/^[0-9a-f]{40}$/.test(baselineProduct)) throw new Error('Pin AUTHOR_MANAGEMENT_BASELINE to the actual product commit');
  const productChanges = execFileSync('git', ['diff', '--name-only', baselineProduct, '--',
    'apps', 'packages', 'services', 'model', 'infra'], { cwd: root, encoding: 'utf8' }).trim();
  if (productChanges) throw new Error(`Product differs from baseline: ${productChanges}`);
  const startedAt = Number(Bun.env.REZICS_QA_PREPARATION_STARTED_AT), startupMs = Date.now() - startedAt;
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0 || startupMs < 0 || startupMs >= 600_000)
    throw new Error('The isolated QA runner must supply a preparation start within the 600-second ceiling');
  const budget = new FixtureWorkBudget(600_000 - startupMs);
  const specification = authorManagementSourceInputs(baselineProduct);
  const execution = assertAuditExecution({ execution: { format: 'audit-execution-v1',
    productBaseline: auditBaseline, productRevision: baselineProduct,
    testRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    fixtureGeneration: sourceKey(specification) } }, { checkout: root, productRevision: baselineProduct });
  const adapter = authorSourceAdapter(specification, context => {
    budget.excludeAdmissionWait(context.budget.admissionWaitMs());
    return produceAuthorManagementCorpus(context, budget, execution, startedAt, startupMs);
  });
  const prepared = await sources.prepare(adapter);
  budget.remaining();
  // Qualify the retained cut with the same supported migrations, retained
  // logins and anonymous reads that every original lifecycle body consumes.
  const smoke = await sources.restore(adapter);
  budget.excludeAdmissionWait(smoke.admissionWaitMs);
  try { budget.remaining(); } finally { await smoke.dispose(); }
  budget.remaining();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(authorManagementManifest, JSON.stringify(prepared.manifest.metadata, null, 2) + '\n', { mode: 0o600 });
  const receipt = { format: 'author-management-preparation-v1', execution,
    sourceDigest: prepared.manifest.digest, recipeDigest: recipeDigest(),
    compatibility: loadCompatibility(root).digest, preparedMs: startupMs + budget.elapsed(),
    admissionWaitMs: budget.admissionWaitMs(), smokeRestoreMs: smoke.candidate.preparation.totalMs,
    backup: (prepared.manifest.metadata as unknown as AuthorManagementCorpus).backup,
    manifestSha256: sha256(readFileSync(authorManagementManifest)) };
  writeFileSync(join(directory, 'preparation.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.info('Author-management preparation', JSON.stringify(receipt));
}

async function produceAuthorManagementCorpus(context: SourceContext, budget: FixtureWorkBudget,
  execution: AuditExecutionMetadata, startedAt: number, startupMs: number) {
  const baselineProduct = execution.productRevision;
  const sessions = await personaSessions('public', { moderatorLifetimeMs: 86_400_000 });
  try {
    const independent = await personaSessions('public', { moderatorLifetimeMs: 86_400_000 });
    const owner = sessions.owner;
    const matching: Work[] = [];
    // Duplicate title keys exercise the ID tie-break, with title order differing from creation order.
    for (let index = 0; index < 23; index++) {
      budget.remaining();
      matching.push(await createWork(owner, `Studio needle ${String(22 - index).padStart(2, '0')} ${index < 2 ? '再会' : 'garden'}`));
    }
    matching[1]!.title = matching[0]!.title;
    const duplicate = await fixtureAnswer<{ revision: string }>(owner.main('POST', '/v1/content-edits', { profile: 'metadata-only-v1',
      work: matching[1]!.work, expectedHead: matching[1]!.workRevision, title: matching[1]!.title,
      actingSubject: owner.actingSubject }));
    matching[1]!.workRevision = duplicate.revision;
    // A distinct edit makes recent order observably different from created order.
    const edited = matching[3]!;
    edited.title += ' revised';
    const edit = await fixtureAnswer<{ revision: string }>(owner.main('POST', '/v1/content-edits', {
      profile: 'metadata-only-v1', work: edited.work, expectedHead: edited.workRevision,
      title: edited.title, actingSubject: owner.actingSubject }));
    edited.workRevision = edit.revision;
    const draft = await createWork(owner, 'Studio needle draft excluded');
    await fixtureAnswer(owner.main('POST', '/v1/contributions', { profile: 'text-contribution-v1',
      work: draft.work, language: 'en', body: 'A private working notebook.', actingSubject: owner.actingSubject }), 201);
    const otherType = await createWork(owner, 'Studio needle recipe excluded', 'https://schema.org/Recipe');
    const foreign = await createWork(sessions.member, 'Studio needle foreign private excluded');
    const agent = await fixtureAnswer<{ agent: string }>(owner.main('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Independent studio pen name' }), 201);
    const alternate = await createWork({ ...owner, actingSubject: agent.agent }, 'Studio needle alternate identity');
    const book = await createWork(owner, 'Studio published field notebook');
    await publishBook(owner, book);
    let composition = await fixtureAnswer<Composition>(owner.main('POST', '/v1/compositions', {
      profile: 'book-composition', work: book.work, mainVersion: book.mainVersion, actingSubject: owner.actingSubject }), 201);
    const chapter = await fixtureAnswer<{ post: string; revision: string; variantId: string; occurrence: string; compositionRevision: string }>(
      owner.main('POST', `/v1/works/${short(book.work)}/chapters`, { profile: 'book-chapter-create-v1',
        title: 'Original chapter', language: 'en', direction: 'ltr', parent: composition.structure,
        position: 'last', expectedCompositionHead: composition.revision, actingSubject: owner.actingSubject }));
    composition.revision = chapter.compositionRevision;
    const chapterContent = await originalContent(owner, chapter.post, chapter.variantId, 'Original chapter about seeds.');
    const change = async (operations: object[]) => {
      budget.remaining();
      composition = { ...composition, ...await fixtureAnswer<Composition>(owner.main('POST',
        `/v1/compositions/${short(composition.structure)}/changes`, { profile: 'book-composition',
          expectedHead: composition.revision, actingSubject: owner.actingSubject, operations })) };
      return composition.occurrences;
    };
    const [group] = await change([{ op: 'insert', parent: composition.structure, position: 'last', role: 'group',
      division: 'volume', label: { value: 'Volume', language: 'en' } }]);
    // Book permits two occurrence levels: root groups hold chapters, not more groups.
    const [chapterGroup] = await change([{ op: 'insert', parent: composition.structure, position: 'last', role: 'group',
      division: 'part', label: { value: 'Part', language: 'en' } }]);
    for (const [parent, count] of [[composition.structure, 16], [composition.structure, 4], [chapterGroup!, 2]] as const)
      await change(Array.from({ length: count }, (_, index) => ({ op: 'insert', parent,
        position: 'last', role: 'chapter', target: chapter.post,
        label: { value: `Original chapter occurrence ${index}`, language: 'en' } })));
    const postBody = 'Original independent Post about seeds.';
    const post = await fixtureAnswer<{ post: string; variantId: string; revisionId: string; byteDigest: string }>(
      owner.main('POST', '/v1/posts', { profile: 'authored-post-v1', title: { value: 'Original Post', language: 'en' },
        language: 'en', document: fromPlainText(postBody, 'blocks'), actingSubject: owner.actingSubject }), 201);
    await fixtureAnswer(owner.main('GET', `/v1/content-revisions/${post.revisionId}?${actorQuery(owner)}`));
    // Read the existing variant list for the Content owner's epoch, without a source-store write.
    const variants = await fixtureAnswer<{ sourcePosition: { dataEpoch: string } }>(owner.main('GET',
      `/v1/works/${short(post.post)}/content-variants?${actorQuery(owner)}`));
    const postContent = await originalContent(owner, post.post, post.variantId, postBody,
      { ...post, sourcePosition: variants.sourcePosition });
    const postHeader = await fixtureAnswer<{ revision: string }>(owner.main('GET',
      `/v1/posts/${short(post.post)}?${actorQuery(owner)}`));
    // A separately published Structure pins the exact old chapter revision. Withdrawing
    // the chapter's own qualification must not retract this independent decision.
    const adoptionWork = await createWork(owner, 'Independent instruction publication', 'https://schema.org/Recipe');
    const adoptionStructure = await fixtureAnswer<Composition>(owner.main('POST', '/v1/compositions', {
      profile: 'recipe-composition', work: adoptionWork.work, mainVersion: adoptionWork.mainVersion,
      actingSubject: owner.actingSubject }), 201);
    const adoptionChange = await fixtureAnswer<{ revision: string }>(owner.main('POST',
      `/v1/compositions/${short(adoptionStructure.structure)}/changes`, { profile: 'recipe-composition',
        expectedHead: adoptionStructure.revision, actingSubject: owner.actingSubject,
        operations: [{ op: 'insert', parent: adoptionStructure.structure, position: 'last', role: 'instruction',
          target: chapterContent.resourceId, selection: { mode: 'fixed-revision', revision: chapterContent.revisionId,
            selector: { grain: 'content', variantId: chapterContent.variantId, revision: chapterContent.revisionId } } }] }));
    const adoption = await fixtureAnswer<{ publicationDecision: string }>(owner.main('POST', '/v1/work-publications', {
      profile: 'work-structure-publication-v1', operation: 'publish', work: adoptionWork.work,
      expectedWorkHead: adoptionWork.workRevision, expectedMainVersion: adoptionWork.mainVersion,
      structure: adoptionStructure.structure, expectedStructureHead: adoptionChange.revision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: owner.actingSubject }), 201);
    const reply = await originalReply(owner, book, sessions.realm, 'An original author reply.');
    const independentReply = await originalReply(sessions.member, book, sessions.realm, 'Another author keeps this reply.');
    await grantPersonaFixtureAuthority(independent.moderator, [
      { scope: `review:decide:${independent.realm}`, action: 'review.decide' },
      { scope: `reply:place:${independent.realm}`, action: 'reply.place' },
    ]);
    const review = await fixtureAnswer<{ decisionId: string }>(independent.moderator.main('POST', '/v1/realm-reply-reviews', {
      profile: 'realm-reply-review-v1', realm: independent.realm, reply: reply.reply,
      revisionId: reply.revisionId, revisionDigest: reply.revisionDigest, expectedGeneration: '0',
      supersedes: null, outcome: 'approved', method: 'human', methodRevision: 'realm-manager-v1',
      dependencyDigest: createHash('sha256').update(book.work).digest('hex'), reasonReference: null,
      actingSubject: independent.moderator.actingSubject }), 201);
    const independentPlaced = await fixtureAnswer<{ placement: string }>(independent.moderator.main('POST',
      '/v1/realm-reply-placements', { profile: 'realm-reply-placement-v1', realm: independent.realm,
        reply: reply.reply, revisionId: reply.revisionId, revisionDigest: reply.revisionDigest,
        reviewDecisionId: review.decisionId, expectedHead: null, actingSubject: independent.moderator.actingSubject }), 201);
    for (const content of [chapterContent, postContent]) await fixtureAnswer(sessions.visitor.main('GET',
      `/v1/content-revisions/${content.revisionId}`));
    const realms: AuthorManagementCorpus['realms'] = [retainPersonaRealm(sessions), retainPersonaRealm(independent)];
    await sessions.close();
    budget.remaining();
    const pool = boundedPool({ connectionString: Bun.env.ACCESS_DATABASE_URL, connectionTimeoutMillis: 2_000 });
    try { await recordRetainedPostgresCollations(context.backup, sql => pool.query(sql)); }
    finally { await pool.end(); }
    const native = new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN, Bun.env.FUSEKI_COMMAND_TOKEN);
    const rdf = stable(await native.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o'));
    writeFileSync(join(context.backup, 'rdf-cut.json'), rdf + '\n', { mode: 0o600 });
    const signal = AbortSignal.timeout(budget.remaining());
    const backup = await retainStoppedOwnerBackup(Bun.env.REZICS_QA_RUN_ID!, backupIdentity(context.key),
      join(context.backup, 'owners'), startedAt, { purpose: 'corpus', resumeSource: false, signal,
        stopSourcePostgres: () => stopCorpusSourcePostgres(Bun.env.REZICS_QA_RUN_ID!, signal) });
    budget.remaining();
    const saved = JSON.parse(readFileSync(backup, 'utf8')) as { project: string };
    const volumes = Object.fromEntries(VOLUME_KINDS.map(kind => [kind,
      retainedVolumeInventory(`${saved.project}_${kind}`, dockerEnvironment())]));
    const corpus: AuthorManagementCorpus = { format: 'author-management-corpus-v1', baselineProduct,
      buildHead: execution.testRevision, execution,
      compatibility: loadCompatibility(root).digest, recipeDigest: recipeDigest(),
      backup: join(sourceDirectory, context.key, 'backup/owners/backup.json'),
      preparedMs: startupMs + budget.elapsed(), realms, inventory: { matching, draft, otherType, foreign,
        alternateAgent: agent.agent, alternate, edited: edited.work }, book, composition,
      chapterOccurrence: chapter.occurrence, group: group!, chapterGroup: chapterGroup!, chapterCount: 23,
      chapter: chapterContent, chapterWorkRevision: chapter.revision,
      post: postContent, postWorkRevision: postHeader.revision,
      adoption: { work: adoptionWork, structure: adoptionStructure.structure, revision: adoptionChange.revision,
        publication: adoption.publicationDecision }, reply, independentReply, independentPlacement: independentPlaced.placement };
    return { metadata: JSON.parse(JSON.stringify(corpus)) as RetainedJson,
      rdfDigest: sha256(readFileSync(join(context.backup, 'rdf-cut.json'))),
      ownerState: JSON.parse(stable({ project: saved.project, volumes })) as RetainedOwnerState,
      producerRevision: execution.testRevision, qaIdentity: Bun.env.REZICS_QA_RUN_ID!,
      phases: { 'public-command-and-stopped-backup': corpus.preparedMs } };
  } finally { await sessions.close(); }
}

export async function restoreAuthorManagementCorpus() {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use goalctl test with an isolated integration stack');
  if (!existsSync(authorManagementManifest)) throw new Error(
    'Missing command-created corpus. Run AUTHOR_MANAGEMENT_PREPARE=1 AUTHOR_MANAGEMENT_BASELINE=<product-sha> '
    + 'REZICS_QA_STACK_MODE=scale bun scripts/goal/goalctl.ts test '
    + 'tests/qa/integration/outcomes/realm/studio-inventory.test.ts -t AMGT00');
  const metadata = JSON.parse(readFileSync(authorManagementManifest, 'utf8')) as AuthorManagementCorpus;
  assertAuditExecution(metadata, { checkout: root, productRevision: metadata.baselineProduct });
  if (metadata.format !== 'author-management-corpus-v1' || metadata.recipeDigest !== recipeDigest()
    || metadata.compatibility !== loadCompatibility(root).digest || metadata.preparedMs > 600_000)
    throw new Error('Retained author-management corpus recipe, storage or preparation differs');
  const adapter = authorSourceAdapter(authorManagementSourceInputs(metadata.execution.productRevision));
  const selected = await sources.restore(adapter);
  if (stable(selected.manifest.metadata) !== stable(metadata)) {
    await selected.dispose();
    throw new Error('Author retained projection differs from the producer-owned source metadata');
  }
  return { ...selected.candidate, close: () => selected.dispose() };
}

async function restoreAuthorCopy(metadata: AuthorManagementCorpus, budget: FixtureWorkBudget) {
  const execution = assertAuditExecution(metadata, { checkout: root, productRevision: metadata.baselineProduct });
  const runId = `author-${randomUUID().replaceAll('-', '').slice(0, 23)}`;
  const copy = await restoreCatalogueBackup(metadata.backup, runId, { resourceClass: 'ordinary' });
  budget.excludeAdmissionWait(copy.admissionWaitMs);
  let sessions: PersonaSessions[] | undefined;
  const environment = { ...copy.apps, REZICS_QA_RUN_ID: runId, REZICS_QA_STACK_TIER: 'integration' };
  const previous = new Map(Object.keys(environment).map(key => [key, Bun.env[key]]));
  try {
    await stream('bun', ['scripts/load/work-profile-restore-migrations.ts', `.temp/stack/rezics-qa-${runId}/apps.env`],
      dockerEnvironment(), undefined, budget.remaining());
    Object.assign(Bun.env, environment);
    sessions = await restorePersonaRealms(metadata.realms);
    for (const content of [metadata.chapter, metadata.post]) await fixtureAnswer(sessions[0]!.visitor.main('GET',
      `/v1/content-revisions/${content.revisionId}`));
    budget.remaining();
    console.info('Author-management restore', JSON.stringify({ runId, baselineProduct: metadata.baselineProduct,
      execution, totalMs: budget.elapsed(), admissionWaitMs: budget.admissionWaitMs() }));
    const live = sessions;
    const preparation = { ...copy.preparation, totalMs: budget.elapsed(), admissionWaitMs: budget.admissionWaitMs() };
    return { metadata, sessions: live[0]!, independent: live[1]!, preparation,
      async close() { try { await live[0]!.close(); } finally { await copy.stop(); } } };
  } catch (error) { try { await sessions?.[0]?.close(); } finally { await copy.stop(); } throw error; }
  finally { for (const [key, value] of previous) { if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value; } }
}
