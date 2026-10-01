import { createHash } from 'node:crypto';
import { derivedId } from '../../../services/main/src/modules/structure/graph.ts';
import { SeedApiError } from './api.ts';
import { grantRealmProfileSeed, officialModClient, realmProfileClient } from './official-authority.ts';
import { editorList, extraWorks, fabricApi, fictionQuotes, fictionWorks, laterModReleases, officialHubItems, officialMods,
  type OfficialRealmId, penNames, publicTexts, realmProfiles, zoneContent } from './official-plan.ts';
import { grantCuratedCollectionSeed, grantHomeSeedAuthority, grantImportedContributionSeedAuthority,
  grantImportedWorkSeedAuthority,
  type LocalOperatorInput } from './operator.ts';
import { demoClassics } from '../../../tests/fixtures/sources/open-library.ts';
import { localizedBilingual, people, profilePlan, seedKey, works } from './plan.ts';
import { seedReply } from './replies.ts';
import { modsConcepts } from './realms-step.ts';
import { gamesCatalogue } from './games-catalogue.ts';
import { softwareCatalogue } from './software-catalogue.ts';
import { requiresSeedAdministrator } from './work-authority.ts';
import { afterCatchUp, refreshSeedTokens, type AgentReceipt, type ContributionReceipt, type PublicationReceipt,
  type SeedState, type Session, type WorkReceipt } from './state.ts';

// The official Zones' content, through Main's public APIs as their authors,
// editors and readers would make it: pen names write serials chapter by
// chapter, stewards adopt them and curate editors' lists, readers read (the
// charts), join (the member lists) and write the quotes editors approve. Every
// command has a stable idempotency key, and reads skip what is already true,
// so the step replays on a seeded stack.

const short = (id: string) => id.slice(-36);
const BOOK = 'https://schema.org/Book';
const DOCUMENT = 'https://schema.org/DigitalDocument';
const kinds = { document: DOCUMENT, mod: 'https://rezics.com/vocab/ModPackage',
  game: 'https://schema.org/VideoGame', software: 'https://schema.org/SoftwareApplication',
  prompt: 'https://rezics.com/vocab/PromptTemplate',
  'skill-package': 'https://rezics.com/vocab/SkillPackage' } as const;
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

/** Main requires a new Work's language. Stacks seeded before that recorded these intents without one, which Main
 * digests as English, so a conflicting replay repeats that. A clean `task dev:reset` gives every Work its own. */
async function createWork(o: Official, body: { language: string } & Record<string, unknown>, token: string, key: string) {
  if (requiresSeedAdministrator(body.semanticTypes as string[])) {
    if (!o.state.operatorSession) throw new Error('Restricted Work seed creation requires the local fixture administrator');
    token = o.state.operatorSession.token;
  }
  return o.api.post<WorkReceipt>('/v1/works', body, token, key).catch((error: unknown) => {
    if (!(error instanceof SeedApiError) || error.status !== 409 || body.language === 'en') throw error;
    return o.api.post<WorkReceipt>('/v1/works', { ...body, language: 'en' }, token, key);
  });
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
  if (demoClassics.some(classic => classic.id === key) && o.state.operatorInput) {
    await grantImportedContributionSeedAuthority(o.state.operatorInput, contribution.contribution);
  }
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
  language: string, tagline: string, completionStatus: 'ongoing' | 'completed' | 'hiatus' | null,
  refreshExisting = false) {
  for (let attempt = 0; ; attempt++) {
    const current = await o.read<{ tagline: { value: string } | null; metadataRevision: string | null }>(
      `/v1/works/${short(target.work)}`);
    if (current?.tagline && (!refreshExisting || current.tagline.value === tagline)) return;
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

/** Preserve the credited author while giving the writing identity an exact editor mandate. */
async function credit(o: Official, key: string, target: WorkReceipt, author: string, as: Session, actor = author) {
  const id = short(target.work);
  const listed = await o.read<{ items: { agent: string; role: string }[] }>(`/v1/works/${id}/agent-credits`);
  if (listed?.items.some(item => item.agent === author && item.role === 'author')) return;
  const work = await o.read<{ revision: string }>(`/v1/works/${id}`);
  if (!work) throw new Error(`Work ${key} is not public`);
  await grantHomeSeedAuthority(o.input(as, actor), [{ action: 'work.edit', scope: `work:edit:${target.work}` }]);
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
    await refreshSeedTokens(o.state);
    await o.state.optional(`Fiction serial ${work.id}`, async () => {
      const author = o.agent(work.author), as = o.writer(work.author), name = work.seedName ?? work.id;
      const target = await createWork(o, { profile: 'metadata-only-v1', title: work.title, semanticTypes: [BOOK],
        language: work.language, authoring: 'own-work', actingSubject: author }, as.token, seedKey('official-work', name));
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
    await refreshSeedTokens(o.state);
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
    await refreshSeedTokens(o.state);
    await o.state.optional(`Zone work ${extra.id}`, async () => {
      const as = o.person(extra.owner);
      if (requiresSeedAdministrator([kinds[extra.type]])) {
        await grantImportedWorkSeedAuthority(o.input(as, as.actingSubject));
      }
      const target = await createWork(o, { profile: 'metadata-only-v1', title: extra.title,
        semanticTypes: [kinds[extra.type]], language: extra.language, authoring: 'own-work',
        actingSubject: as.actingSubject }, as.token, seedKey('official-work', extra.id));
      await describeWork(o, extra.id, target, as.actingSubject, as, extra.language, extra.tagline, null,
        extra.id === 'lumen-fabric');
      o.works.set(extra.id, { work: target, language: extra.language,
        published: await publish(o, extra.id, target, as.actingSubject, as, extra.language, extra.text) });
    });
  }
}

/** Each seeded game and app carries its catalogue pitch as its English tagline. */
async function gameAndAppTaglines(o: Official) {
  const items = [
    ...gamesCatalogue.map(game => ({ id: game.id, pitch: game.pitch, owner: 'mira' })),
    ...softwareCatalogue.map(app => ({ id: app.id, pitch: app.pitch, owner: 'daniel' })),
  ];
  for (const item of items) {
    await refreshSeedTokens(o.state);
    await o.state.optional(`Tagline ${item.id}`, () => afterCatchUp(async () => {
      const placed = o.works.get(item.id);
      if (!placed?.published) throw new Error(`Work ${item.id} is not public`);
      const as = o.person(item.owner);
      await describeWork(o, item.id, placed.work, as.actingSubject, as, 'en', item.pitch, null);
    }));
  }
}

/** Verified native captures become explicit, disclosure-safe Work bindings. */
async function mods(o: Official) {
  const as = o.person('jun');
  const api = await officialModClient(o.operator);
  for (const item of officialMods) {
    await refreshSeedTokens(o.state);
    await o.state.optional(`Public mod ${item.id}`, async () => {
      const token = await api.token(as.cookie);
      const target = o.works.get(item.id);
      if (!target?.published) throw new Error(`Mod Work ${item.id} is not public`);
      const manifest = item.ecosystem === 'fabric'
        ? JSON.stringify({ schemaVersion: 1, id: item.nativeId, version: item.release,
          environment: 'client', depends: {} })
        : `modLoader="javafml"\nloaderVersion="[52,)"\nlicense="MIT"\nclientSideOnly=true\n[[mods]]\nmodId="${item.nativeId}"\nversion="${item.release}"\n`;
      const bytes = Buffer.from(manifest);
      const resolved = await api.post<{ resolution: { resolution: string } }>(
        '/v1/package-resolutions/mods', { profile: 'mod-native-capture-v1', ecosystem: item.ecosystem,
          side: 'CLIENT', root: item.nativeId, runtime: { loaderVersion: '52', gameVersion: '1.21.1' },
          captures: [{ identity: item.nativeId, surface: 'manifest', status: 'observed',
            bytesBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }] },
      token, seedKey('official-mod-resolution', item.id));
      await api.post(`/v1/package-resolutions/mods/${short(resolved.resolution.resolution)}/work-binding`,
        { work: target.work.work, actingSubject: as.actingSubject }, token,
        seedKey('official-mod-binding', item.id));
    });
  }
  const capture = (identity: string, text: string) => {
    const bytes = Buffer.from(text);
    return { identity, surface: 'manifest', status: 'observed' as const, bytesBase64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  // Later releases list beside the first: the versions, dependencies and notes a mod page shows.
  for (const later of laterModReleases) {
    const item = officialMods.find(mod => mod.id === later.mod)!;
    const ecosystem = later.ecosystem ?? item.ecosystem;
    const key = `${item.id}:${later.release}:${later.gameVersion}${ecosystem === item.ecosystem ? '' : `:${ecosystem}`}`;
    await refreshSeedTokens(o.state);
    await o.state.optional(`Mod release ${key}`, async () => {
      const token = await api.token(as.cookie);
      const target = o.works.get(item.id);
      if (!target?.published) throw new Error(`Mod Work ${item.id} is not public`);
      const manifest = ecosystem === 'forge'
        ? `modLoader="javafml"\nloaderVersion="[47,)"\nlicense="MIT"\nclientSideOnly=true\n[[mods]]\nmodId="${item.nativeId}"\nversion="${later.release}"\n`
        : JSON.stringify({ schemaVersion: 1, id: item.nativeId, version: later.release,
          ...later.environment ? { environment: later.environment } : {}, depends: later.depends ?? {},
          ...later.recommends ? { recommends: later.recommends } : {}, ...later.breaks ? { breaks: later.breaks } : {} });
      const resolved = await api.post<{ resolution: { resolution: string } }>(
        '/v1/package-resolutions/mods', { profile: 'mod-native-capture-v1', ecosystem,
          side: 'CLIENT', root: item.nativeId,
          runtime: { loaderVersion: ecosystem === 'forge' ? '47' : '0.16.10', gameVersion: later.gameVersion },
          captures: [capture(item.nativeId, manifest), ...ecosystem === 'fabric' ? [capture(fabricApi.id,
            JSON.stringify({ schemaVersion: 1, id: fabricApi.id, version: fabricApi.version }))] : []] },
        token, seedKey('official-mod-release-resolution', key));
      await api.post(`/v1/package-resolutions/mods/${short(resolved.resolution.resolution)}/work-binding`,
        { work: target.work.work, actingSubject: as.actingSubject, changelog: later.changelog }, token,
        seedKey('official-mod-release-binding', key));
    });
  }
}

/** The steward accepts game/loader Senses in Mods, independently of its navigation Context. */
async function modClassifications(o: Official) {
  const { receipt: { realm }, steward } = o.realm('mods');
  await grantHomeSeedAuthority(o.input(steward, steward.actingSubject), [
    { action: 'classification.context.configure', scope: `classification:context:${realm}` },
    { action: 'classification.decision.set', scope: `classification:decide:${realm}` },
  ]);
  if (!await o.read(`/v1/realms/${short(realm)}/classification-context`)) {
    await o.api.post('/v1/classification-contexts', { profile: 'classification-context-v1',
      realm, actingSubject: steward.actingSubject }, steward.token, seedKey('official-mod-acceptance', realm));
  }
  const concepts = await modsConcepts(o.state, steward);
  for (const item of officialMods) {
    const target = o.works.get(item.id);
    if (!target?.published) throw new Error(`Mod Work ${item.id} is not public`);
    for (const label of ['Minecraft', item.ecosystem === 'fabric' ? 'Fabric' : 'Forge']) {
      const sense = concepts.get(label)!.sense;
      const selection = { context: { kind: 'realm-classification', id: realm },
        work: target.work.work, mainVersion: target.work.mainVersion, sense };
      const current = await o.api.post<{ state: string; source: string; decision: string | null }>(
        '/v1/classification-resolutions', { profile: 'classification-resolution-v1', ...selection },
        steward.token, seedKey('official-mod-classification-read', `${item.id}:${label}`));
      if (current.state === 'accepted') continue;
      const expectedDecisionHead = current.source === 'local' ? current.decision : null;
      await o.api.post('/v1/classification-decisions', {
        profile: 'classification-direct-decision-v1', ...selection, expectedDecisionHead,
        outcome: 'accepted', actingSubject: steward.actingSubject }, steward.token,
      seedKey('official-mod-classification', `${item.id}:${label}:${expectedDecisionHead ?? 'first'}`));
    }
  }
}

/** Wait for the automatic discovery refresh after all seed writes, then exercise
 * the same public Sense links as the Mods chips. No rating Context belongs here. */
export async function checkModsDiscovery(state: SeedState) {
  const realm = state.createdRealms.find(item => item.id === 'mods')?.receipt.realm;
  if (!realm) throw new Error('Mods Realm is unavailable');
  const zone = await state.api.getPublic<{ presentation: { modules: Array<{ id: string;
    source: { kind: string; context?: string } }> } }>(`/v1/realms/${short(realm)}/zone`);
  const context = zone.presentation.modules.find(item => item.id === 'games')?.source.context;
  if (!context) throw new Error('Mods game and loader navigation Context is unavailable');
  const deadline = Date.now() + 60_000;
  let pending = 'Discovery refresh';
  while (Date.now() < deadline) {
    let genres: { items: Array<{ id: string; name: { value: string } }> };
    try {
      genres = await state.api.getPublic(`/v1/realms/${short(realm)}/modules/genres/${short(context)}?language=en`);
    } catch (error) {
      if (!(error instanceof SeedApiError) || error.status !== 503 || !error.detail.includes('discovery_unavailable')) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
    const results: string[] = [];
    for (const label of ['Minecraft', 'Fabric', 'Forge', 'NeoForge']) {
      const term = genres.items.find(item => item.name.value === label)?.id;
      if (!term) throw new Error(`Mods has no ${label} Sense`);
      const params = new URLSearchParams({ scope: 'realm', realm, term, language: 'en' });
      const response = await fetch(`${state.endpoints.main}/v1/works?${params}`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))) });
      if ([409, 503].includes(response.status)) { await response.body?.cancel(); break; }
      if (!response.ok) throw new SeedApiError('Mods Discover', response.status, await response.text());
      const page = await response.json() as { stale: boolean; nextCursor: string | null;
        items: Array<{ title: { value: string } }> };
      if (page.stale) break;
      const expected = officialMods.filter(item => label === 'Minecraft' || item.ecosystem === label.toLowerCase())
        .map(item => extraWorks.find(work => work.id === item.id)!.title).sort();
      const actual = page.items.map(item => item.title.value).sort();
      if (page.nextCursor || JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Mods ${label} Discover returned ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`);
      }
      results.push(`${label}=${actual.length}`);
    }
    if (results.length === 4) {
      console.log(`Mods discovery: ${results.join(', ')}.`);
      return;
    }
    pending = `Discovery refresh (${results.length}/4 genre queries current)`;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`${pending} did not finish within 60 seconds`);
}

/** Content publication and public eligibility make exact Hub revisions available to Zone cards. */
const officialSkillDescriptions = {
  'recipe-skill-v1': 'Scale recipe ingredients for a new serving count, with separate checks for seasoning and cooking time.',
  'reading-skill-v1': 'Organize reading notes by theme, summarize them, and collect open questions without adding unsupported details.',
} as const;

async function hubItems(o: Official) {
  const as = o.person('aria');
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
    properties: { notes: { type: 'string' } }, required: ['notes'], additionalProperties: false };
  for (const item of officialHubItems) {
    await refreshSeedTokens(o.state);
    await o.state.optional(`Published Hub item ${item.id}`, async () => {
      const target = o.works.get(item.id);
      if (!target?.published) throw new Error(`Hub Work ${item.id} is not public`);
      const resourceId = target.work.work;
      await grantHomeSeedAuthority(o.input(as, as.actingSubject), [
        { action: 'work.read', scope: `work:read:${resourceId}` },
        { action: 'content.draft', scope: `content:draft:${resourceId}` },
        { action: 'content.publish', scope: `content:publish:${resourceId}` },
        { action: 'content.search-eligibility', scope: `content:search-eligibility:${resourceId}` },
      ]);
      const variantId = `urn:rezics:variant:${derivedId(`official-hub:${item.id}`).slice(-36)}`;
      const identity = { resourceId, variantId, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
        direction: 'ltr', expectedHead: null, actingSubject: as.actingSubject };
      const revision = item.kind === 'prompt'
        ? await o.api.post<{ revision: string; contentEpoch: string }>('/v1/prompts/revisions', {
          ...identity, profile: 'rezics-prompt-revision-v1', content: item.content,
          parameterSchema: schema, examples: [{ parameters: { notes: 'Readers disagreed about the ending.' },
            output: 'What did the ending mean to each reader?' }], applicability: { models: [], tools: [] } },
        as.token, seedKey('official-hub-revision-v2', item.id))
        : await o.api.post<{ revision: string; contentEpoch: string }>('/v1/hub/imports', {
          ...identity, profile: 'agent-skills-directory-import-v1', sourceFormat: 'agent-skills-directory-v1',
          sourceLocator: { label: item.name },
          files: [{ path: 'SKILL.md', executable: false,
            bytesBase64: Buffer.from(`---\nname: ${item.name}\ndescription: ${item.content.slice(0, 180)}\n---\n# ${item.name}\n${item.content}\n`).toString('base64') }] },
        as.token, seedKey('official-hub-revision-v2', item.id));
      const exact = await o.read<{ reference: { byteDigest: string } }>(
        `/v1/content-revisions/${revision.revision}?actingSubject=${encodeURIComponent(as.actingSubject)}`,
        as.token);
      if (!exact) throw new Error(`Hub revision ${item.id} is unreadable`);
      const published = await o.api.post<{ decision: string; status: string }>('/v1/content-publications', {
        profile: 'content-publication-v1', preparationId: seedKey('official-hub', item.id),
        revisionId: revision.revision, expectedDigest: exact.reference.byteDigest,
        expectedContentEpoch: revision.contentEpoch, resourceId, variantId,
        expectedPublicationHead: null, actingSubject: as.actingSubject },
      as.token, seedKey('official-hub-publication', item.id));
      if (published.status !== 'active') throw new Error(`Hub revision ${item.id} is not published`);
      const eligibility = await o.api.post<{ decision: string; outcome: string }>('/v1/content-search-eligibility', { profile: 'content-search-eligibility-v1',
        resourceId, variantId, publicationDecision: published.decision, expectedEligibilityHead: null,
        actingSubject: as.actingSubject, rightsBasis: 'original-contribution', disclosure: 'public' },
      as.token, seedKey('official-hub-eligibility', item.id));
      if (eligibility.outcome !== 'succeeded' || !eligibility.decision) {
        throw new Error(`Hub revision ${item.id} is not public`);
      }
      if (item.kind === 'skill-package') {
        // Keep the v2 inputs above exact for idempotent replay on existing stacks.
        // Move all three heads together through their APIs, with independent retry keys.
        const next = await o.api.post<{ revision: string; contentEpoch: string }>('/v1/hub/imports', {
          ...identity, expectedHead: revision.revision,
          profile: 'agent-skills-directory-import-v1', sourceFormat: 'agent-skills-directory-v1',
          sourceLocator: { label: item.name }, files: [{ path: 'SKILL.md', executable: false,
            bytesBase64: Buffer.from(`---\nname: ${item.name}\ndescription: ${officialSkillDescriptions[item.id]}\n---\n# ${item.name}\n${item.content}\n`).toString('base64') }] },
        as.token, seedKey('official-hub-revision-v3', item.id));
        const bytes = await o.read<{ reference: { byteDigest: string } }>(
          `/v1/content-revisions/${next.revision}?actingSubject=${encodeURIComponent(as.actingSubject)}`, as.token);
        if (!bytes) throw new Error(`Hub revision ${item.id} v3 is unreadable`);
        const publication = await o.api.post<{ decision: string; status: string }>('/v1/content-publications', {
          profile: 'content-publication-v1', preparationId: seedKey('official-hub-v3', item.id),
          revisionId: next.revision, expectedDigest: bytes.reference.byteDigest,
          expectedContentEpoch: next.contentEpoch, resourceId, variantId,
          expectedPublicationHead: published.decision, actingSubject: as.actingSubject },
        as.token, seedKey('official-hub-publication-v3', item.id));
        if (publication.status !== 'active') throw new Error(`Hub revision ${item.id} v3 is not published`);
        const selected = await o.api.post<{ outcome: string }>('/v1/content-search-eligibility', {
          profile: 'content-search-eligibility-v1', resourceId, variantId,
          publicationDecision: publication.decision, expectedEligibilityHead: eligibility.decision,
          actingSubject: as.actingSubject, rightsBasis: 'original-contribution', disclosure: 'public' },
        as.token, seedKey('official-hub-eligibility-v3', item.id));
        if (selected.outcome !== 'succeeded') throw new Error(`Hub revision ${item.id} v3 is not public`);
      }
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
        // Preserve the original create request digest on already seeded stacks; the name revision below replaces it.
        const createName = list.name.labels.en && list.name.labels['zh-Hans']
          ? `${list.name.labels.en} · ${list.name.labels['zh-Hans']}`
          : list.name.labels[list.name.original]!;
        await granted(() => o.api.post('/v1/collections', { collection, name: createName, disclosure: 'public',
          actingSubject: steward.actingSubject }, steward.token, seedKey('official-list', `${id}:${list.id}`)),
        () => grantCuratedCollectionSeed(o.input(steward, steward.actingSubject), collection));
        const namePath = `/v1/collections/${short(collection)}/name`;
        const currentName = await o.read<{ revision: string | null; name: typeof list.name }>(namePath);
        if (!currentName) throw new Error(`Editors’ list ${id}:${list.id} name is unreadable`);
        if (JSON.stringify(currentName.name) !== JSON.stringify(list.name)) {
          await granted(() => o.api.put(namePath, { profile: 'collection-public-name-v1',
            expectedHead: currentName.revision, actingSubject: steward.actingSubject, name: list.name },
          steward.token, seedKey('official-list-name', `${id}:${list.id}:${currentName.revision ?? 'first'}`)),
          () => grantCuratedCollectionSeed(o.input(steward, steward.actingSubject), collection));
        }
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
    const rules = profile.rules.map(rule => ({ ...rule, title: localizedBilingual(rule.title),
      body: localizedBilingual(rule.body), governanceRule: null }));
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
      const header = await o.read<{ profileRevision: string | null; profileContract: string | null;
        description: { value: string } | null;
        moderators: { items: string[] } }>(`${root}?language=en`);
      if (header?.profileContract === 'realm-public-profile-v2'
        && header.description?.value === profile.description.en
        && JSON.stringify(header.moderators.items) === JSON.stringify(moderators)) return;
      await grantRealmProfileSeed(o.input(realm.steward, realm.steward.actingSubject),
        [{ action: 'realm.profile.publish', realm: realm.receipt.realm }]);
      await o.api.put(`${root}/profile`, { profile: 'realm-public-profile-v2',
        expectedHead: header?.profileRevision ?? null, actingSubject: realm.steward.actingSubject,
        publication: { name: localizedBilingual(profile.name),
          description: localizedBilingual(profile.description), iconSelection: null,
          bannerSelection: null, rules: profile.rules.map(rule => ({ ...rule,
            title: localizedBilingual(rule.title), body: localizedBilingual(rule.body), governanceRule: null })),
          count: { kind: 'exact', value: null }, moderators } },
      await token(realm.steward.id), seedKey('official-profile-v2', `${id}:${header?.profileRevision?.slice(-12) ?? 'first'}`));
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
  await gameAndAppTaglines(o);
  await mods(o);
  await hubItems(o);
  await refreshSeedTokens(state);
  await state.optional('Official Zones: adoptions', () => adoptions(o));
  await refreshSeedTokens(state);
  await state.optional('Mods: game and loader classifications', () => modClassifications(o));
  await editorLists(o);
  await refreshSeedTokens(state);
  await state.optional('Official Realms: joining and rules', () => joining(o));
  await refreshSeedTokens(state);
  await profiles(o);
  await refreshSeedTokens(state);
  await state.optional('Fiction: reader quotes', () => quotes(o));
  for (const [id, placed] of o.works) if (placed.published) state.publicWorks.set(id, { work: placed.work, ...placed.published });
}
