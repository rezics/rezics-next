import { SeedApiError } from './api.ts';
import { bookConcepts, freeConcepts, genreConcepts, seededBookIds, type BookConcept } from './genres-plan.ts';
import { fictionWorks } from './official-plan.ts';
import { grantHomeSeedAuthority } from './operator.ts';
import { seedKey } from './plan.ts';
import { refreshSeedTokens, type SeedState } from './state.ts';

interface Proposition { concept: string; sense: string }
interface Resolution { state: string; source: string; decision: string | null }
const fictionBookIds = new Set([
  ...fictionWorks.map(work => work.id), 'serial', 'moonlight-story', 'journey-west',
  'red-chamber', 'strange-tales', 'three-kingdoms', 'water-margin',
]);

async function accept(state: SeedState, work: { work: string; mainVersion: string },
  proposition: Proposition, context: { kind: 'global' } | { kind: 'realm-classification'; id: string },
  steward: SeedState['sessions'][number], key: string) {
  const selection = { context, work: work.work, mainVersion: work.mainVersion, sense: proposition.sense };
  const current = await state.api.post<Resolution>('/v1/classification-resolutions',
    { profile: 'classification-resolution-v1', ...selection }, steward.token,
    seedKey('book-concept-resolution', key));
  if (current.state === 'accepted' && (context.kind === 'global' || current.source === 'local')) return;
  const expectedDecisionHead = current.source === 'local' ? current.decision : null;
  await state.api.post('/v1/classification-decisions', {
    profile: 'classification-direct-decision-v1', ...selection, expectedDecisionHead,
    outcome: 'accepted', actingSubject: steward.actingSubject }, steward.token,
  seedKey('book-concept-decision', `${key}:${expectedDecisionHead ?? 'first'}`));
}

/** Accept two to four Concepts on every demo Book, in Global and its editorial Realm. */
export async function seedBookConcepts(state: SeedState) {
  if (!state.operatorInput) throw new Error('Book Concepts require the local fixture operator');
  const books = state.createdRealms.find(item => item.id === 'books');
  const fiction = state.createdRealms.find(item => item.id === 'fiction');
  if (!books || !fiction) throw new Error('Book Concepts require Books and Fiction Realms');
  const definitions = { ...genreConcepts, ...freeConcepts };
  const owner = books.steward;
  const input = (steward: typeof owner) => ({ ...state.operatorInput!,
    ownerAccountSubject: steward.accountId, actingSubject: steward.actingSubject });
  await grantHomeSeedAuthority(input(owner), [
    { action: 'classification.proposition.define', scope: 'classification:define:global' },
    { action: 'classification.decision.set', scope: 'classification:decide:global' },
    { action: 'classification.context.configure', scope: `classification:context:${books.receipt.realm}` },
    { action: 'classification.decision.set', scope: `classification:decide:${books.receipt.realm}` },
  ]);
  await grantHomeSeedAuthority(input(fiction.steward), [
    { action: 'classification.context.configure', scope: `classification:context:${fiction.receipt.realm}` },
    { action: 'classification.decision.set', scope: `classification:decide:${fiction.receipt.realm}` },
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
  for (const [id, label] of Object.entries(definitions) as [BookConcept, string][]) {
    await refreshSeedTokens(state);
    propositions.set(id, await state.api.post<Proposition>('/v1/classification-propositions', {
      profile: 'classification-proposition-v1', label, actingSubject: owner.actingSubject }, owner.token,
    seedKey('book-concept-v1', id)));
  }
  for (const id of seededBookIds) {
    await refreshSeedTokens(state);
    const target = state.publicWorks.get(id)?.work ?? state.created.get(id);
    if (!target) throw new Error(`Book ${id} was not seeded`);
    const realm = fictionBookIds.has(id) ? fiction : books;
    for (const concept of bookConcepts[id] ?? []) {
      const proposition = propositions.get(concept)!;
      await accept(state, target, proposition, { kind: 'global' }, owner, `${id}:${concept}:global`);
      await accept(state, target, proposition, { kind: 'realm-classification', id: realm.receipt.realm },
        realm.steward, `${id}:${concept}:${realm.id}`);
    }
  }
  console.log(`Book Concepts: ${propositions.size} Concepts on ${seededBookIds.length} Books.`);
}
