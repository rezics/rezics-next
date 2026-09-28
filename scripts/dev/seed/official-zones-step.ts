import { createHash } from 'node:crypto';
import { derivedId } from '../../../services/main/src/modules/structure/graph.ts';
import { SeedApiError } from './api.ts';
import { grantRealmProfileSeed, realmProfileClient } from './official-authority.ts';
import { editorList, extraWorks, fictionQuotes, fictionWorks, type OfficialRealmId, penNames, publicTexts,
  realmProfiles, zoneContent } from './official-plan.ts';
import { grantCuratedCollectionSeed, grantHomeSeedAuthority, type LocalOperatorInput } from './operator.ts';
import { people, profilePlan, seedKey, works } from './plan.ts';
import { seedReply } from './replies.ts';
import type { AgentReceipt, ContributionReceipt, PublicationReceipt, SeedState, Session, WorkReceipt }
  from './state.ts';

// The official Zones' content, through Main's public APIs as their authors,
// editors and readers would make it: pen names write serials chapter by
// chapter, stewards adopt them and curate editors' lists, readers read (the
// charts), join (the member lists) and write the quotes editors approve. Every
// command has a stable idempotency key, and reads skip what is already true,
// so the step replays on a seeded stack.

const short = (id: string) => id.slice(-36);
const BOOK = 'https://schema.org/Book';
const DOCUMENT = 'https://schema.org/DigitalDocument';
interface Published { contribution: string; decision: string; draftRevision: string }
interface Placed { work: WorkReceipt; language: string; published: Published | null }

class Official {
  readonly works = new Map<string, Placed>();
  readonly agents = new Map<string, string>();
  constructor(readonly state: SeedState, readonly operator: LocalOperatorInput) {}

  get api() { return this.state.api; }
  person(id: string): Session {
    const session = this.state.sessions.find(item => item.id === id);
    if (!session) throw new Error(`Demo person ${id} has no session`);
    return session;
  }
  /** The Agent a plan author names: a pen name made here, one the base plan made, or a person. */
  agent(id: string): string {
    const agent = this.agents.get(id) ?? this.state.penAgents.get(id)
      ?? this.state.sessions.find(item => item.id === id)?.actingSubject;
    if (!agent) throw new Error(`Author ${id} has no Agent`);
    return agent;
  }
  /** Who writes as an author: the pen name's owner, or the person. The base plan's pen names are Lin Mei's. */
  writer(author: string): Session {
    const pen = penNames.find(item => item.id === author);
    return this.person(pen?.owner ?? (this.state.penAgents.has(author) ? 'mei' : author));
  }
  realm(id: OfficialRealmId) {
    const realm = this.state.createdRealms.find(item => item.id === id);
    if (!realm) throw new Error(`Official Realm ${id} was not created`);
    return realm;
  }
  /** Fixture authority on the local stack, for `actor` as the person `as` represents. */
  input(as: Session, actor: string): LocalOperatorInput {
    return { ...this.operator, ownerAccountSubject: as.accountId, actingSubject: actor };
  }
  /** A read; Main answers 409 or 503 while the graph moves under it, so those are tried again a few times. */
  async read<T>(path: string, token?: string): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${this.api.endpoints.main}${path}`,
        token ? { headers: { authorization: `Bearer ${token}` } } : {});
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (response.ok) return await response.json() as T;
      if (attempt < 4 && [409, 503].includes(response.status)) {
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      throw new SeedApiError(`Main ${path}`, response.status, (await response.text()).slice(0, 300));
    }
  }
}

/** Runs `write`; when Main refuses it for want of authority, grants the exact fixture scopes and runs it once more. */
async function granted<T>(write: () => Promise<T>, grant: () => Promise<void>): Promise<T> {
  try { return await write(); }
  catch (error) {
    if (!(error instanceof SeedApiError) || error.status !== 403) throw error;
    await grant();
    return write();
  }
}

async function penNameAgents(o: Official) {
  for (const pen of penNames) {
    const owner = o.person(pen.owner);
    const agent = await o.api.post<AgentReceipt>('/v1/agents', { profile: 'agent-provision-v1', kind: 'person',
      displayName: pen.displayName }, owner.token, seedKey('official-agent', pen.id));
    if (agent.state !== 'active') throw new Error(`Pen name ${pen.id} is not active`);
    o.agents.set(pen.id, agent.agent);
    const current = await o.read<{ revision: string; handle: string; bio: { text: string } | null }>(
      `/v1/agents/${short(agent.agent)}`);
    if (current?.handle !== pen.handle) {
      await o.state.optional('Pen name handle', () => o.api.put(`/v1/agents/${short(agent.agent)}/handle`,
        { profile: 'agent-handle-v1', handle: pen.handle, expectedHandle: null }, owner.token,
        seedKey('official-handle', pen.id)));
    }
    if (current && current.bio?.text !== pen.bio) {
      await o.state.optional('Pen name bio', () => o.api.put(`/v1/agents/${short(agent.agent)}/profile`, {
        profile: 'agent-public-profile-v1', expectedHead: current.revision, displayName: pen.displayName,
        avatarSelection: null, bio: { text: pen.bio, language: pen.bioLanguage } }, owner.token,
      seedKey('official-bio', `${pen.id}:${current.revision.slice(-12)}`)));
    }
  }
}

/** A Work's public text: one contribution, published and selected as its Main Version's text. */
async function publish(o: Official, key: string, target: WorkReceipt, author: string, as: Session,
  language: string, body: string): Promise<Published> {
  const contribution = await o.api.post<ContributionReceipt>('/v1/contributions', { profile: 'text-contribution-v1',
    work: target.work, language, body, actingSubject: author }, as.token, seedKey('official-contribution', key));
  const published = await o.api.post<PublicationReceipt>('/v1/contribution-publications', {
    profile: 'text-publication-v1', contribution: contribution.contribution,
    expectedDraftHead: contribution.draftRevision, expectedPublicationHead: null,
    rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: author },
  as.token, seedKey('official-publication', key));
  await o.api.post('/v1/publication-selections', { profile: 'main-default-selection-v1',
    context: { kind: 'main-version-default', id: target.mainVersion }, work: target.work,
    contribution: contribution.contribution, publicationDecision: published.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: author },
  as.token, seedKey('official-selection', key));
  return { contribution: contribution.contribution, decision: published.publicationDecision,
    draftRevision: contribution.draftRevision };
}

/** The Work's hook and serial state. Main refuses a write whose basis moved meanwhile; it is read again, a few times. */
async function describeWork(o: Official, key: string, target: WorkReceipt, author: string, as: Session,
  language: string, tagline: string, completionStatus: 'ongoing' | 'completed' | 'hiatus' | null) {
  for (let attempt = 0; ; attempt++) {
    const current = await o.read<{ tagline: unknown; metadataRevision: string | null }>(`/v1/works/${short(target.work)}`);
    if (current?.tagline) return;
    try {
      await o.api.put(`/v1/works/${short(target.work)}/metadata`, { profile: 'work-metadata-details-v1',
        expectedHead: current?.metadataRevision ?? null,
        state: { kind: 'header', originalTitle: null, completionStatus,
          localized: [{ language, title: null, description: null, mainVersionLabel: null, tagline }] },
        actingSubject: author }, as.token, seedKey('official-metadata',
        `${key}:${current?.metadataRevision?.slice(-12) ?? 'first'}${attempt ? `:${attempt}` : ''}`));
      return;
    } catch (error) {
      if (attempt >= 3 || !(error instanceof SeedApiError) || error.status !== 409) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

/** The author's credit, until Main credits a Work's creator by itself. `actor` maintains the Work. */
async function credit(o: Official, key: string, target: WorkReceipt, author: string, as: Session, actor = author) {
  const id = short(target.work);
  const listed = await o.read<{ items: { agent: string; role: string }[] }>(`/v1/works/${id}/agent-credits`);
  if (listed?.items.some(item => item.agent === author && item.role === 'author')) return;
  const work = await o.read<{ revision: string }>(`/v1/works/${id}`);
  if (!work) throw new Error(`Work ${key} is not public`);
  await o.api.post(`/v1/works/${id}/agent-credits`, { profile: 'native-agent-credit-v1',
    credit: `https://rezics.com/id/${derivedId(`official-credit:${key}`).slice(-36)}`, agent: author, role: 'author',
    expectedWorkHead: work.revision, actingSubject: actor }, as.token,
  seedKey('official-credit', `${key}:${work.revision.slice(-12)}`));
}

interface Contents { composition: string; compositionRevision: string;
  items: { occurrence: string; role: string; label: { value: string } | null; target: string | null;
    selectedRevision: string | null }[] }

/**
 * A serial's chapters through Studio's chapter command: each is created under
 * the Work with its title, then drafted, published and made public. Chapters
 * that already exist are recognised by title and not created again.
 */
async function chapters(o: Official, key: string, target: WorkReceipt, author: string, as: Session,
  language: string, planned: readonly { title: string; body: string }[]) {
  const workId = short(target.work);
  const composition = await o.api.post<{ structure: string; revision: string }>('/v1/compositions', {
    profile: 'book-composition', work: target.work, mainVersion: target.mainVersion, actingSubject: author },
  as.token, seedKey('official-composition', key));
  // An empty composition has no public contents yet; its first chapter starts from the creation head.
  const contents = async () => (await o.read<Contents>(`/v1/works/${workId}/contents?limit=20`))
    ?? { composition: composition.structure, compositionRevision: composition.revision, items: [] };
  let current = await contents();
  for (const [index, chapter] of planned.entries()) {
    const chapterKey = seedKey('official-chapter', `${key}:${index}`);
    const seed = `${target.work}\0${author}\0${chapterKey}\0chapter`;
    const chapterWork = derivedId(`${seed}\0work`);
    const variantId = `urn:rezics:variant:${derivedId(`${seed}\0variant`).slice(-36)}`;
    const existing = current.items.find(item => item.role === 'chapter' && item.target === chapterWork);
    if (!existing) {
      if (current.items.some(item => item.label?.value === chapter.title)) continue; // Made another way; leave it.
      const made = await o.api.post<{ compositionRevision: string; work: string }>(`/v1/works/${workId}/chapters`, {
        profile: 'book-chapter-create-v1', title: chapter.title, language, direction: 'ltr',
        parent: composition.structure, position: 'last', expectedCompositionHead: current.compositionRevision,
        actingSubject: author }, as.token, chapterKey);
      if (made.work !== chapterWork) throw new Error(`Chapter ${key}:${index} has another identity`);
      current = { ...current, compositionRevision: made.compositionRevision,
        items: [...current.items, { occurrence: '', role: 'chapter', label: { value: chapter.title },
          target: chapterWork, selectedRevision: null }] };
    } else if (existing.selectedRevision) continue;
    await chapterText(o, `${key}:${index}`, chapterWork, variantId, author, as, language, `${chapter.title}\n${chapter.body}`);
  }
  return { structure: composition.structure, contents: await contents() };
}

async function chapterText(o: Official, key: string, resource: string, variantId: string, author: string,
  as: Session, language: string, body: string) {
  const grant = () => grantHomeSeedAuthority(o.input(as, author), [
    { action: 'work.read', scope: `work:read:${resource}` },
    { action: 'content.draft', scope: `content:draft:${resource}` },
    { action: 'content.publish', scope: `content:publish:${resource}` },
    { action: 'content.search-eligibility', scope: `content:search-eligibility:${resource}` }]);
  const saved = await granted(() => o.api.post<{ revisionId: string; sourcePosition: { dataEpoch: string } }>(
    '/v1/content-drafts', { profile: 'content-text-v1', resourceId: resource, variantId,
      language: { kind: 'tag', tag: language, originalTag: language }, direction: 'ltr', expectedHead: null, body,
      actingSubject: author }, as.token, seedKey('official-chapter-draft', key)), grant);
  const exact = await o.read<{ reference: { byteDigest: string } }>(
    `/v1/content-revisions/${saved.revisionId}?actingSubject=${encodeURIComponent(author)}`, as.token);
  if (!exact) throw new Error(`Chapter draft ${key} is unreadable`);
  const published = await granted(() => o.api.post<{ decision: string; status: string }>('/v1/content-publications', {
    profile: 'content-publication-v1', preparationId: seedKey('official-chapter', key), revisionId: saved.revisionId,
    expectedDigest: exact.reference.byteDigest, expectedContentEpoch: saved.sourcePosition.dataEpoch,
    resourceId: resource, variantId, expectedPublicationHead: null, actingSubject: author },
  as.token, seedKey('official-chapter-publication', key)), grant);
  if (published.status !== 'active' || !published.decision) throw new Error(`Chapter ${key} is not published`);
  await granted(() => o.api.post('/v1/content-search-eligibility', { profile: 'content-search-eligibility-v1',
    resourceId: resource, variantId, publicationDecision: published.decision, expectedEligibilityHead: null,
    actingSubject: author, rightsBasis: 'original-contribution', disclosure: 'public' },
  as.token, seedKey('official-chapter-eligibility', key)), grant);
}

/** Demo readers read a serial's chapters this week; how many readers each serial has orders the charts. */
async function readers(o: Official, key: string, structure: string, contents: Contents, count: number) {
  const occurrences = contents.items.filter(item => item.role === 'chapter' && item.selectedRevision)
    .map(item => item.occurrence);
  if (!occurrences.length) throw new Error(`Serial ${key} has no readable chapter`);
  for (const [index, reader] of o.state.sessions.slice(0, count).entries()) {
    for (const [ordinal, occurrence] of occurrences.slice(0, 1 + (index % occurrences.length)).entries()) {
      await o.state.optional('Official chart reading', () => o.api.put(
        `/v1/compositions/${short(structure)}/occurrences/${short(occurrence)}/progress`, {
          actingSubject: reader.actingSubject, expectedVersion: 0, completed: ordinal < index,
          position: `paragraph:${ordinal + 1}` }, reader.token,
        seedKey('official-progress', `${reader.id}:${short(occurrence)}`)));
    }
  }
}

async function fictionSerials(o: Official) {
  for (const work of fictionWorks) {
    await o.state.optional(`Fiction serial ${work.id}`, async () => {
      const author = o.agent(work.author), as = o.writer(work.author), name = work.seedName ?? work.id;
      const target = await o.api.post<WorkReceipt>('/v1/works', { profile: 'metadata-only-v1', title: work.title,
        semanticTypes: [BOOK], authoring: 'own-work', actingSubject: author }, as.token, seedKey('official-work', name));
      o.works.set(work.id, { work: target, language: work.language, published: null });
      await describeWork(o, name, target, author, as, work.language, work.tagline, work.completionStatus);
      const published = await publish(o, name, target, author, as, work.language, work.opening);
      o.works.set(work.id, { work: target, language: work.language, published });
      await o.state.optional('Fiction author credit', () => credit(o, name, target, author, as));
      const serial = await chapters(o, name, target, author, as, work.language, work.chapters);
      await readers(o, name, serial.structure, serial.contents, work.readers);
    });
  }
  // The base plan's Fiction Works keep their authors too; the profile step may have met a moving graph.
  for (const { agent, work, role } of profilePlan.credits) {
    const target = o.state.created.get(work);
    if (role !== 'author' || !target || !zoneContent.fiction.adopt.includes(work)) continue;
    await o.state.optional('Fiction author credit', () => credit(o, work, target, o.agent(agent), o.state.sessions[0]!,
      o.state.sessions[0]!.actingSubject));
  }
  console.log(`Fiction: ${[...o.works.values()].filter(item => item.published).length}/${fictionWorks.length} serials.`);
}

/** Classics, recipes and guides for the lighter Zones: public texts on base-plan Works, and a few new Works. */
async function lighterTexts(o: Official) {
  for (const [id, text] of Object.entries(publicTexts)) {
    const target = o.state.created.get(id);
    if (!target || o.state.publicForRealm.has(id)) continue;
    await o.state.optional(`Public text ${id}`, async () => {
      const authorId = works.find(work => work.id === id)?.author;
      const as = authorId ? o.writer(authorId) : o.person('mei');
      const author = authorId ? o.agent(authorId) : as.actingSubject;
      if (text.tagline) {
        await describeWork(o, id, target, author, as, text.language, text.tagline,
          text.completionStatus ?? null);
      }
      o.works.set(id, { work: target, language: text.language,
        published: await publish(o, id, target, author, as, text.language, text.text) });
    });
  }
  for (const extra of extraWorks) {
    await o.state.optional(`Zone work ${extra.id}`, async () => {
      const as = o.person(extra.owner);
      const target = await o.api.post<WorkReceipt>('/v1/works', { profile: 'metadata-only-v1', title: extra.title,
        semanticTypes: [DOCUMENT], authoring: 'own-work', actingSubject: as.actingSubject }, as.token, seedKey('official-work', extra.id));
      await describeWork(o, extra.id, target, as.actingSubject, as, extra.language, extra.tagline, null);
      o.works.set(extra.id, { work: target, language: extra.language,
        published: await publish(o, extra.id, target, as.actingSubject, as, extra.language, extra.text) });
    });
  }
}

function publicWork(o: Official, id: string): { work: WorkReceipt; contribution: string; decision: string } | null {
  const own = o.works.get(id);
  if (own?.published) return { work: own.work, ...own.published };
  const base = o.state.publicForRealm.get(id), work = o.state.created.get(id);
  return base && work ? { work, ...base } : null;
}

/** Each steward adopts the Zone's Works; the last adopted lead the Zone's picks. */
async function adoptions(o: Official) {
  let count = 0;
  for (const [id, content] of Object.entries(zoneContent) as [OfficialRealmId, typeof zoneContent.fiction][]) {
    const realm = o.realm(id);
    await grantHomeSeedAuthority(o.input(realm.steward, realm.steward.actingSubject),
      [{ action: 'publication.adopt', scope: `publication:adopt:${realm.receipt.realm}` }]);
    for (const workId of content.adopt) {
      const work = publicWork(o, workId);
      if (!work) continue;
      const adopted = await o.state.optional('Official adoption', () => o.api.post('/v1/publication-selections', {
        profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: realm.receipt.realm },
        work: work.work.work, mainVersion: work.work.mainVersion, contribution: work.contribution,
        publicationDecision: work.decision, expectedSelectionHead: null, selectionBasis: 'realm-manager-review',
        actingSubject: realm.steward.actingSubject }, realm.steward.token, seedKey('realm-adoption', `${id}:${workId}`)));
      if (adopted) count++;
    }
  }
  console.log(`Official Zones: ${count} adoptions.`);
}

/** Each Zone's editors' lists: public Collections its steward curates, brought to the plan's members in order. */
async function editorLists(o: Official) {
  for (const [id, content] of Object.entries(zoneContent) as [OfficialRealmId, typeof zoneContent.fiction][]) {
    const realm = o.realm(id), steward = realm.steward;
    for (const list of content.lists) {
      await o.state.optional('Official editors’ list', async () => {
        const collection = editorList(id, list.id);
        const members = list.works.flatMap(work => { const found = publicWork(o, work); return found ? [found.work.work] : []; });
        await granted(() => o.api.post('/v1/collections', { collection, name: list.name, disclosure: 'public',
          actingSubject: steward.actingSubject }, steward.token, seedKey('official-list', `${id}:${list.id}`)),
        () => grantCuratedCollectionSeed(o.input(steward, steward.actingSubject), collection));
        const current = await o.read<{ structure: string; revision: string;
          occurrences: { occurrence: string; role: string; target: string | null }[] }>(
          `/v1/collections/${short(collection)}?actingSubject=${encodeURIComponent(steward.actingSubject)}&limit=100`,
          steward.token);
        if (!current) throw new Error(`Editors’ list ${id}:${list.id} is unreadable`);
        const held = current.occurrences.filter(item => item.role === 'member');
        // Main takes one kind of operation per change, at most 16: removals first, then additions.
        const removals = held.filter(item => !item.target || !members.includes(item.target))
          .map(item => ({ op: 'remove', occurrence: item.occurrence }));
        const additions = members.filter(target => !held.some(item => item.target === target)).map(target => ({
          op: 'insert', role: 'member', parent: current.structure, position: 'last', target,
          selection: { mode: 'follow-context' } }));
        let head = current.revision;
        for (const operations of [removals, additions]) {
          if (!operations.length) continue;
          const changed = await o.api.post<{ revision: string }>(`/v1/collections/${short(collection)}/changes`, {
            expectedHead: head, actingSubject: steward.actingSubject, operations }, steward.token,
          seedKey('official-list-members', `${id}:${list.id}:${head.slice(-12)}`));
          head = changed.revision;
        }
      });
    }
  }
}

interface Settings { generation: string; settings: { visibility: string; reviewRequired: boolean;
  reviewMode?: string; whoMaySubmit: string; selfJoin?: boolean; rules: unknown[] };
ruleBasis: { revision: string | null } }

/** Stewards open each Realm to members who join on their own and publish its rules; the demo people join. */
async function joining(o: Official) {
  let joined = 0;
  for (const [id, profile] of Object.entries(realmProfiles) as [OfficialRealmId, typeof realmProfiles.fiction][]) {
    const realm = o.realm(id), steward = realm.steward, root = `/v1/realms/${short(realm.receipt.realm)}`;
    await o.api.post(`${root}/management`, { actingSubject: steward.actingSubject }, steward.token,
      seedKey('realm-management', short(realm.receipt.realm)));
    const rules = profile.rules.map(rule => ({ ...rule, governanceRule: null }));
    const current = await o.read<Settings>(`${root}/settings?actingSubject=${encodeURIComponent(steward.actingSubject)}`,
      steward.token);
    if (current && (!current.settings.selfJoin || JSON.stringify(current.settings.rules) !== JSON.stringify(rules))) {
      await o.api.put(`${root}/settings`, { actingSubject: steward.actingSubject, expectedGeneration: current.generation,
        reason: 'Open the official community to readers and publish its rules',
        settings: { ...current.settings, selfJoin: true, rules }, expectedRulesRevision: current.ruleBasis.revision },
      steward.token, seedKey('official-settings', `${id}:${current.generation}`));
    }
    for (const member of o.state.sessions.filter(session => session.id !== steward.id)) {
      const result = await o.state.optional('Official Realm join', async () => {
        const policy = await o.read<{ selfJoin: boolean; open: boolean; state: string; membershipGeneration: string;
          policyRevision: string; termsRevision: string }>(
          `${root}/joining?actingSubject=${encodeURIComponent(member.actingSubject)}`, member.token);
        if (!policy || policy.state === 'joined' || !policy.selfJoin || !policy.open) return null;
        return o.api.post(`${root}/join`, { actingSubject: member.actingSubject,
          expectedMembershipGeneration: policy.membershipGeneration, expectedPolicyRevision: policy.policyRevision,
          termsRevision: policy.termsRevision,
          // One demo person joins without being listed, as anyone may.
          listed: member.id !== 'leo' }, member.token,
        seedKey('official-join', `${id}:${member.id}:${policy.membershipGeneration}`));
      });
      if (result) joined++;
    }
  }
  console.log(`Official Realms: ${joined} new members.`);
}

/** Each Realm's public profile (description, member count and moderators), with each moderator's own consent. */
async function profiles(o: Official) {
  const client = await realmProfileClient(o.operator);
  const tokens = new Map<string, string>();
  const token = async (person: string) => {
    let value = tokens.get(person);
    if (!value) {
      const credentials = people.find(item => item.id === person);
      if (!credentials) throw new Error(`Demo person ${person} has no credentials`);
      value = await client.token((await client.signInOrUp(credentials)).cookie);
      tokens.set(person, value);
    }
    return value;
  };
  for (const [id, profile] of Object.entries(realmProfiles) as [OfficialRealmId, typeof realmProfiles.fiction][]) {
    await o.state.optional(`Realm profile ${id}`, async () => {
      const realm = o.realm(id), root = `/v1/realms/${short(realm.receipt.realm)}`;
      const moderators: string[] = [];
      for (const person of profile.moderators) {
        const moderator = o.person(person);
        await grantRealmProfileSeed(o.input(moderator, moderator.actingSubject), [{ action: 'realm.moderator.choose',
          realm: realm.receipt.realm, agent: moderator.actingSubject }]);
        const chosen = await o.state.optional('Public moderator choice', async () => o.api.put(
          `${root}/moderators/${short(moderator.actingSubject)}/public-choice`, {
            profile: 'realm-public-moderator-choice-v1', expectedHead: null, public: true,
            actingSubject: moderator.actingSubject }, await token(person),
          seedKey('official-moderator-choice', `${id}:${person}`)).catch(error => {
          // A choice made on an earlier run stands; only its first command has no head.
          if (error instanceof SeedApiError && error.status === 409) return true;
          throw error;
        }));
        if (chosen) moderators.push(moderator.actingSubject);
      }
      const header = await o.read<{ profileRevision: string | null; description: { value: string } | null;
        moderators: { items: string[] } }>(`${root}?language=en`);
      if (header?.description?.value === profile.description.en
        && JSON.stringify(header.moderators.items) === JSON.stringify(moderators)) return;
      await grantRealmProfileSeed(o.input(realm.steward, realm.steward.actingSubject),
        [{ action: 'realm.profile.publish', realm: realm.receipt.realm }]);
      await o.api.put(`${root}/profile`, { profile: 'realm-public-profile-v1',
        expectedHead: header?.profileRevision ?? null, actingSubject: realm.steward.actingSubject,
        publication: { name: profile.name, description: profile.description, iconSelection: null,
          bannerSelection: null, rules: profile.rules.map(rule => ({ ...rule, governanceRule: null })),
          count: { kind: 'exact', value: null }, moderators } },
      await token(realm.steward.id), seedKey('official-profile', `${id}:${header?.profileRevision?.slice(-12) ?? 'first'}`));
    });
  }
}

/** Readers' replies the Fiction editors approved and placed, which the Zone quotes. */
async function quotes(o: Official) {
  const realm = o.realm('fiction'), steward = realm.steward, root = `/v1/realms/${short(realm.receipt.realm)}`;
  // The editors' role carries the review decision; the steward holds it for the demo.
  const roles = await o.read<{ generation: string; roles: { id: string }[] }>(
    `${root}/roles?actingSubject=${encodeURIComponent(steward.actingSubject)}`, steward.token);
  const roleId = derivedId(`official-editors:${realm.receipt.realm}`).slice(-36);
  if (roles && !roles.roles.some(role => role.id === roleId)) {
    await roleChange(o, root, steward, { kind: 'role', roleId, name: 'Fiction editors',
      permissions: ['review.decide', 'publication.adopt'] }, 'editors-role');
  }
  await o.state.optional('Fiction editors’ assignment', () => roleChange(o, root, steward, { kind: 'assignment', roleId,
    member: steward.actingSubject, assigned: true, validUntil: new Date(Date.now() + 90 * 86_400_000).toISOString() },
  'editors-assignment', true));
  let placed = 0;
  for (const quote of fictionQuotes) {
    const work = o.works.get(quote.work), reader = o.person(quote.reader);
    if (!work?.published) continue;
    const done = await o.state.optional('Fiction reader quote', async () => {
      const reply = await seedReply(o.api, reader, { id: `official-quote:${quote.work}:${quote.reader}`,
        work: work.work.work, revision: work.published!.draftRevision, language: work.language }, quote.body);
      // Its author reads the draft's digest, which the review and placement bind to.
      const exact = await o.read<{ revisionDigest: string }>(`/v1/member-replies/${short(reply.reply)}?actingSubject=${
        encodeURIComponent(reader.actingSubject)}`, reader.token);
      if (!exact) throw new Error('Reader quote is unreadable');
      const review = await o.api.post<{ decisionId: string }>('/v1/realm-reply-reviews', {
        profile: 'realm-reply-review-v1', realm: realm.receipt.realm, reply: reply.reply, revisionId: reply.revisionId,
        revisionDigest: exact.revisionDigest, expectedGeneration: '0', supersedes: null, outcome: 'approved',
        method: 'human', methodRevision: 'realm-manager-v1',
        dependencyDigest: createHash('sha256').update(work.published!.draftRevision).digest('hex'),
        reasonReference: null, actingSubject: steward.actingSubject }, steward.token,
      seedKey('official-quote-review', `${quote.work}:${quote.reader}`));
      await o.api.post('/v1/realm-reply-placements', { profile: 'realm-reply-placement-v1', realm: realm.receipt.realm,
        reply: reply.reply, revisionId: reply.revisionId, revisionDigest: exact.revisionDigest,
        reviewDecisionId: review.decisionId, expectedHead: null, actingSubject: steward.actingSubject },
      steward.token, seedKey('official-quote-placement', `${quote.work}:${quote.reader}`));
      return true;
    });
    if (done) placed++;
  }
  console.log(`Fiction: ${placed}/${fictionQuotes.length} reader quotes.`);
}

async function roleChange(o: Official, root: string, steward: Session, change: object, label: string, skipEmpty = false) {
  const roles = await o.read<{ generation: string }>(`${root}/roles?actingSubject=${encodeURIComponent(steward.actingSubject)}`,
    steward.token);
  if (!roles) throw new Error('Realm roles are unavailable');
  const input = { actingSubject: steward.actingSubject, expectedGeneration: roles.generation,
    reason: 'Let the Fiction editors approve reader replies', change };
  const preview = await o.api.post<{ digest: string; affectedCount: number }>(`${root}/role-impact`, input,
    steward.token, seedKey('official-role-impact', `${label}:${roles.generation}`));
  if (skipEmpty && preview.affectedCount === 0) return;
  await o.api.post(`${root}/role-changes`, { ...input, impactDigest: preview.digest }, steward.token,
    seedKey('official-role', `${label}:${roles.generation}`));
}

/** The official Zones' publications: serials, adoptions, lists, readers, members, profiles and quotes. */
export async function seedOfficialZones(state: SeedState) {
  if (!state.operatorInput || state.createdRealms.length === 0) {
    state.findings.add('Official Zones: the Realms or the local fixture operator are unavailable');
    return;
  }
  const o = new Official(state, state.operatorInput);
  await state.optional('Official Zones: pen names', () => penNameAgents(o));
  await fictionSerials(o);
  await lighterTexts(o);
  await state.optional('Official Zones: adoptions', () => adoptions(o));
  await editorLists(o);
  await state.optional('Official Realms: joining and rules', () => joining(o));
  await profiles(o);
  await state.optional('Fiction: reader quotes', () => quotes(o));
}
