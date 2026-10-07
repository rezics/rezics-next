import { createHash } from 'node:crypto';
import { SeedApiError } from './api.ts';
import { acceptClassifiedStatement, discloseClassificationConcept, rejectClassifiedStatement,
  shareClassificationContext, type ClassificationPost, type ClassificationResolution,
  type ClassificationScope, type SharedClassificationContext } from './classified-statement.ts';
import { bookConcepts, freeConcepts, genreConcepts, seededBookIds, type BookConcept } from './genres-plan.ts';
import { fictionWorks } from './official-plan.ts';
import { grantHomeSeedAuthority } from './operator.ts';
import { seedKey } from './plan.ts';
import { refreshSeedTokens, type SeedState } from './state.ts';

/** Idempotency keys are at most 128 characters; IRIs enter them as short digests. */
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

interface Proposition { scheme: string; schemeHead: string; concept: string; sense: string; definitionRevision: string }
const fictionBookIds = new Set([
  ...fictionWorks.map(work => work.id), 'serial', 'moonlight-story', 'journey-west',
  'red-chamber', 'strange-tales', 'three-kingdoms', 'water-margin',
]);

const postOf = (state: SeedState): ClassificationPost => (path, body, token, key) => state.api.post(path, body, token, key);

async function resolve(state: SeedState, work: { work: string; mainVersion: string }, sense: string,
  scope: ClassificationScope, steward: SeedState['sessions'][number], key: string) {
  return state.api.post<ClassificationResolution>('/v1/classification-resolutions',
    { profile: 'classification-resolution-v1', context: scope, work: work.work, mainVersion: work.mainVersion, sense },
    steward.token, key);
}

async function accept(state: SeedState, work: { work: string; mainVersion: string },
  proposition: Proposition, scope: ClassificationScope, interpretation: SharedClassificationContext,
  steward: SeedState['sessions'][number], key: string) {
  // Keys name the Sense: earlier English-only Senses used the same Book and Concept keys.
  const senseKey = `${key}:${digest(proposition.sense)}`;
  const current = await resolve(state, work, proposition.sense, scope, steward,
    seedKey('book-concept-resolution', senseKey));
  const head = current.source === 'local' && current.decision ? digest(current.decision) : 'first';
  await acceptClassifiedStatement(postOf(state), steward.token, steward.actingSubject, work, proposition.concept,
    interpretation, scope, current, { statement: seedKey('book-concept-statement', senseKey),
      decision: seedKey('book-concept-decision', `${senseKey}:${head}`) });
}

async function rejectLegacy(state: SeedState, work: { work: string; mainVersion: string },
  proposition: { sense: string }, scope: ClassificationScope, steward: SeedState['sessions'][number], key: string) {
  const current = await resolve(state, work, proposition.sense, scope, steward,
    seedKey('book-legacy-concept-resolution', key));
  if (current.state !== 'accepted' || (scope.kind !== 'global' && current.source !== 'local') || !current.decision) return;
  const defined = await state.api.getPublic<{ concept: string; definitionRevision: string }>(
    `/v1/classification-propositions/${proposition.sense.slice(-36)}`);
  const interpretation = await shareClassificationContext(postOf(state), steward.token, steward.actingSubject,
    [{ concept: defined.concept, definitionRevision: defined.definitionRevision }],
    seedKey('book-legacy-context', digest(proposition.sense)));
  await rejectClassifiedStatement(postOf(state), steward.token, steward.actingSubject, work, defined.concept,
    interpretation, scope, current, { statement: seedKey('book-legacy-statement', key),
      decision: seedKey('book-legacy-concept-rejection', `${key}:${digest(current.decision)}`) });
}

/** The English-only label G-425 stored. A bilingual label is the current scheme, not this one. */
export function legacyPropositionLabel(id: string, definition: { en: string; zh: string }): string {
  return `${definition.en}${definition.zh === '经典' || ['gothic', 'satire',
    'comingOfAge', 'historical', 'adventure'].includes(id) ? '' : ` · ${definition.zh}`}`;
}

/** A legacy label the current scheme shares names the current Sense itself: rejecting it would undo each run's accept. */
export function legacyToReject(legacy: { sense: string } | undefined, current: { sense: string }) {
  return legacy && legacy.sense !== current.sense ? legacy : null;
}

/** An existing isolated proposition with that exact label, never the current scheme's shorter one. */
export function legacyConcept(items: readonly { concept: string; label: string }[], label: string) {
  return items.find(item => item.label === label) ?? null;
}

/** Accept two to four Concepts on every demo Book, in Global and its editorial Realm. */
export async function seedBookConcepts(state: SeedState) {
  if (!state.operatorInput) throw new Error('Book Concepts require the local fixture operator');
  const books = state.createdRealms.find(item => item.id === 'books');
  const fiction = state.createdRealms.find(item => item.id === 'fiction');
  if (!books || !fiction) throw new Error('Book Concepts require Books and Fiction Realms');
  const owner = books.steward;
  const input = (steward: typeof owner) => ({ ...state.operatorInput!,
    ownerAccountSubject: steward.accountId, actingSubject: steward.actingSubject });
  await grantHomeSeedAuthority(input(owner), [
    { action: 'classification.proposition.define', scope: 'classification:define:global' },
    { action: 'statement.decide', scope: 'classification:decide:global' },
    { action: 'classification.context.configure', scope: `classification:context:${books.receipt.realm}` },
    { action: 'statement.decide', scope: `classification:decide:${books.receipt.realm}` },
    { action: 'context.create', scope: 'context:create:root' },
    { action: 'statement.record', scope: `statement:speak:${owner.actingSubject}` },
  ]);
  await grantHomeSeedAuthority(input(fiction.steward), [
    { action: 'classification.context.configure', scope: `classification:context:${fiction.receipt.realm}` },
    { action: 'statement.decide', scope: `classification:decide:${fiction.receipt.realm}` },
    { action: 'context.create', scope: 'context:create:root' },
    { action: 'statement.record', scope: `statement:speak:${fiction.steward.actingSubject}` },
  ]);
  for (const realm of [books, fiction]) {
    const path = `/v1/realms/${realm.receipt.realm.slice(-36)}/classification-context`;
    const response = await fetch(`${state.endpoints.main}${path}`);
    if (response.status === 404) {
      await response.body?.cancel();
      await state.api.post('/v1/classification-contexts', { profile: 'classification-context-v1',
        realm: realm.receipt.realm, actingSubject: realm.steward.actingSubject }, realm.steward.token,
      seedKey('book-classification-context', realm.id));
    } else if (!response.ok) {
      throw new SeedApiError(`Main ${path}`, response.status, (await response.text()).slice(0, 300));
    } else await response.body?.cancel();
  }
  const propositions = new Map<BookConcept, Proposition>();
  for (const [schemeName, entries] of [
    ['genres', Object.entries(genreConcepts)], ['free-tags', Object.entries(freeConcepts)],
  ] as const) {
    let scheme: { id: string; expectedHead: string } | null = null;
    for (const [id, definition] of entries) {
      await refreshSeedTokens(state);
      const broaderKey = 'broader' in definition ? definition.broader : null;
      const parent = broaderKey ? propositions.get(broaderKey) : null;
      if (broaderKey && !parent) throw new Error(`Book Concept ${id} needs ${broaderKey} first`);
      const created: Proposition = await state.api.post<Proposition>('/v1/classification-vocabulary', {
        profile: 'classification-proposition-v2', scheme,
        labels: [{ language: 'en', value: definition.en },
          { language: 'zh-Hans', value: definition.zh }],
        alternativeLabels: [], broader: parent ? [parent.concept] : [], narrower: [],
        actingSubject: owner.actingSubject }, owner.token,
      seedKey('book-concept-v2', `${schemeName}:${id}`));
      propositions.set(id as BookConcept, created);
      scheme = { id: created.scheme, expectedHead: created.schemeHead };
    }
  }
  // Prior G-425 runs used isolated, English-only definitions. A fresh stack must
  // not create them again: suggestions come from the current scheme only. When
  // one is already there, rejecting its decisions removes the old chips.
  const legacy = new Map<BookConcept, { sense: string }>();
  for (const [id, definition] of Object.entries({ ...genreConcepts, ...freeConcepts }) as
    [BookConcept, { en: string; zh: string }][]) {
    if (id === 'fiction') continue;
    await refreshSeedTokens(state);
    const label = legacyPropositionLabel(id, definition);
    const found = await state.api.getPublic<{ items: { concept: string; label: string }[] }>(
      `/v1/concepts?${new URLSearchParams({ q: label, language: 'en', limit: '8', isolated: 'true' })}`);
    const match = legacyConcept(found.items, label);
    if (!match) continue;
    const page = await state.api.getPublic<{ interpretations: string[] }>(
      `/v1/concepts/${match.concept.slice(-36)}`);
    const sense = page.interpretations[0];
    if (sense) legacy.set(id, { sense });
  }
  const interpretation = await shareClassificationContext(postOf(state), owner.token, owner.actingSubject,
    [...propositions.values()].map(item => ({ concept: item.concept, definitionRevision: item.definitionRevision })),
    seedKey('book-classification-context', 'scheme'));
  for (const item of propositions.values()) {
    await discloseClassificationConcept(postOf(state), owner.token, owner.actingSubject, item.concept,
      seedKey('book-concept-hint', digest(item.concept)));
    await discloseClassificationConcept(postOf(state), owner.token, owner.actingSubject, item.concept,
      seedKey('book-concept-hint-books', digest(item.concept)), { kind: 'realm', realm: books.receipt.realm });
    await discloseClassificationConcept(postOf(state), fiction.steward.token, fiction.steward.actingSubject, item.concept,
      seedKey('book-concept-hint-fiction', digest(item.concept)), { kind: 'realm', realm: fiction.receipt.realm });
  }
  for (const id of seededBookIds) {
    await refreshSeedTokens(state);
    const target = state.publicWorks.get(id)?.work ?? state.created.get(id);
    if (!target) throw new Error(`Book ${id} was not seeded`);
    const realm = fictionBookIds.has(id) ? fiction : books;
    for (const concept of bookConcepts[id] ?? []) {
      const proposition = propositions.get(concept)!;
      const old = legacy.get(concept);
      if (legacyToReject(old, proposition)) {
        await rejectLegacy(state, target, old!, { kind: 'global' }, owner, `${id}:${concept}:global`);
        await rejectLegacy(state, target, old!, { kind: 'realm-classification', id: realm.receipt.realm },
          realm.steward, `${id}:${concept}:${realm.id}`);
      }
      await accept(state, target, proposition, { kind: 'global' }, interpretation, owner, `${id}:${concept}:global`);
      await accept(state, target, proposition, { kind: 'realm-classification', id: realm.receipt.realm },
        interpretation, realm.steward, `${id}:${concept}:${realm.id}`);
    }
  }
  console.log(`Book Concepts: ${propositions.size} Concepts on ${seededBookIds.length} Books.`);
}
