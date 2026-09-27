import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readEnv } from '../config.ts';
import { SeedApi, SeedApiError, type SeedEndpoints } from './api.ts';
import { people, realms, seedKey, semanticTypes, works } from './plan.ts';
import { seedReply } from './replies.ts';
import { seedRealmManagement } from './realm-management.ts';
import { seedFeed } from './feed.ts';
import { seedChapterProgress } from './progress.ts';
import { grantCuratedCollectionSeed, grantHomeSeedAuthority, grantOfficialZoneSeed, operatorSeedSession }
  from './operator.ts';
import { DEFAULT_ZONE_PRESENTATION, ZONE_PRESETS }
  from '../../../services/main/src/modules/zone/presentation-format.ts';
import { prepareHomeV2Chapters, seedHomeV2 } from './home-v2.ts';

interface Options { dryRun: boolean; resetOwn: boolean }
interface WorkReceipt { work: string; mainVersion: string; workRevision: string; mainRevision: string;
  replayed: boolean }
interface SpaceReceipt { space: string; realm: string; replayed: boolean }
interface AgentReceipt { agent: string; state: string; replayed: boolean }
interface ContributionReceipt { contribution: string; draftRevision: string; replayed: boolean }
interface PublicationReceipt { publicationDecision: string; replayed: boolean }

export function parseOptions(args: string[]): Options {
  if (args.some(arg => !['--dry-run', '--reset-own'].includes(arg))
    || new Set(args).size !== args.length) {
    throw new Error('Usage: bun scripts/dev/seed/cli.ts [--dry-run] [--reset-own]');
  }
  return { dryRun: args.includes('--dry-run'), resetOwn: args.includes('--reset-own') };
}

function commonRoot(): string {
  const root = resolve(import.meta.dir, '../../..');
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'],
    { cwd: root, encoding: 'utf8' }).trim();
  return dirname(isAbsolute(common) ? common : resolve(root, common));
}

function configuration(): { endpoints: SeedEndpoints; operator: { id: string; email: string;
  password: string }; accountDatabaseUrl: string; accountSecret: string;
  accessDatabaseUrl: string } {
  const directory = Bun.env.REZICS_SEED_STACK_DIRECTORY
    ? resolve(Bun.env.REZICS_SEED_STACK_DIRECTORY) : join(commonRoot(), '.temp/stack/rezics-dev');
  const envPath = join(directory, 'dev.env');
  const publicPath = join(directory, 'web-auth/public.json');
  const privatePath = join(directory, 'web-auth/private.json');
  if (![envPath, publicPath, privatePath].every(existsSync)) {
    throw new Error('Shared dev stack is absent; start it from the main checkout with task dev');
  }
  const env = readEnv(envPath);
  const publicConfig = JSON.parse(readFileSync(publicPath, 'utf8')) as {
    clientId: string; redirectUris: string[]; scope: string; resource: string };
  const privateConfig = JSON.parse(readFileSync(privatePath, 'utf8')) as {
    operator: { id: string; email: string; password: string } };
  const account = env.ACCOUNT_ORIGIN ?? env.ACCOUNT_BASE_URL;
  const main = env.MAIN_ORIGIN;
  if (!account || !main || !publicConfig.redirectUris[0] || !publicConfig.scope) {
    throw new Error('Dev stack lacks its public OAuth client');
  }
  for (const origin of [account, main]) {
    if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) {
      throw new Error('The demo seed accepts loopback Account and Main APIs only');
    }
  }
  if (!privateConfig.operator?.id || !env.ACCOUNT_DATABASE_URL || !env.ACCESS_DATABASE_URL
    || !env.ACCOUNT_SECRET) throw new Error('Dev stack lacks its operator grant fixture');
  return { operator: privateConfig.operator, accountDatabaseUrl: env.ACCOUNT_DATABASE_URL,
    accessDatabaseUrl: env.ACCESS_DATABASE_URL, accountSecret: env.ACCOUNT_SECRET,
    endpoints: { account, main,
    mailpit: `http://127.0.0.1:${env.MAILPIT_HTTP_PORT ?? '8025'}`,
    clientId: publicConfig.clientId,
    redirectUri: publicConfig.redirectUris[0], resource: publicConfig.resource,
    scope: publicConfig.scope } };
}

function stableId(id: string): string {
  const hex = createHash('sha256').update(`rezics-dev-seed-v1:${id}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function describe(error: unknown): string {
  if (error instanceof SeedApiError) {
    let code = '';
    try { code = (JSON.parse(error.detail) as { code?: string }).code ?? ''; } catch { /* opaque */ }
    return `${error.operation} HTTP ${error.status}${code ? ` ${code}` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function run(options: Options): Promise<boolean> {
  console.log(`Demo plan: ${people.length} accounts, ${works.length} Works, ${realms.length} Realms.`);
  if (options.dryRun) {
    for (const work of works) console.log(`  ${work.id}: ${work.title} [${work.type}]`);
    if (options.resetOwn) console.log('Reset requires a public API to delete the seed-owned graph and Access data.');
    return true;
  }
  if (options.resetOwn) {
    throw new Error('--reset-own is unavailable: public APIs cannot remove seed-owned Works, '
      + 'Agents, Spaces and Access grants together. No data was changed.');
  }
  const { endpoints, operator, accountDatabaseUrl, accountSecret, accessDatabaseUrl } = configuration();
  const api = new SeedApi(endpoints);
  const findings = new Set<string>();
  async function optional<T>(label: string, operation: () => Promise<T>): Promise<T | null> {
    try { return await operation(); }
    catch (error) { findings.add(`${label}: ${describe(error)}`); return null; }
  }
  const sessions: Array<{ id: string; accountId: string; token: string; actingSubject: string }> = [];
  let agentCount = 0;
  for (const person of people) {
    const signed = await api.signInOrUp(person);
    const token = await api.token(signed.cookie);
    const agent = await api.post<AgentReceipt>('/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: person.name },
    token, seedKey('agent', person.id));
    if (agent.state !== 'active') throw new Error(`Agent for ${person.id} is not active`);
    await api.put(`/v1/agents/${agent.agent.slice(-36)}/handle`,
      { profile: 'agent-handle-v1', handle: person.handle, expectedHandle: null },
      token, seedKey('handle', person.id));
    sessions.push({ id: person.id, accountId: signed.id, token, actingSubject: agent.agent });
    agentCount++;
  }
  const owner = sessions[0]!;
  const ownerToken = owner.token;
  const operatorInput = { endpoints, credentials: operator, accountDatabaseUrl,
    accountSecret, accessDatabaseUrl, accountSubject: operator.id,
    ownerAccountSubject: owner.accountId, actingSubject: owner.actingSubject };
  const operatorSession = await operatorSeedSession(operatorInput);
  for (const [id, displayName, kind] of [
    ['moonlight', '月下书生 · Moonlit Scribe', 'person'],
    ['northstar', 'North Star Editions · 北辰出版', 'organization'],
  ] as const) {
    const agent = await optional('Pen name / organization Agent', () => api.post<AgentReceipt>('/v1/agents', {
      profile: 'agent-provision-v1', kind, displayName }, ownerToken, seedKey('agent', id)));
    if (agent?.state === 'active') agentCount++;
  }
  const created = new Map<string, WorkReceipt>();
  for (const work of works) {
    const receipt = await api.post<WorkReceipt>('/v1/works', {
      profile: 'metadata-only-v1', title: work.title, semanticTypes: semanticTypes(work.type),
      actingSubject: owner.actingSubject }, ownerToken, seedKey('work', work.id));
    created.set(work.id, receipt);
    if (work.tagline) await grantHomeSeedAuthority(operatorInput,
      [{ action: 'work.edit', scope: `work:edit:${receipt.work}` }]);
    if (work.tagline) await optional('Work serial summary', () => api.put(
      `/v1/works/${receipt.work.slice(-36)}/metadata`, {
        profile: 'work-metadata-details-v1', expectedHead: null,
        state: { kind: 'header', originalTitle: null, completionStatus: work.completionStatus ?? null,
          localized: [{ language: work.language, title: null, description: null,
            mainVersionLabel: null, tagline: work.tagline }] },
        actingSubject: owner.actingSubject }, ownerToken, seedKey('serial-metadata', work.id)));
    console.log(`Work ${created.size}/${works.length}: ${work.title}${receipt.replayed ? ' (replayed)' : ''}`);
  }
  const createdRealms: Array<{ id: string; receipt: SpaceReceipt;
    steward: typeof owner }> = [];
  for (const [index, realm] of realms.entries()) {
    // Give each official Realm its own member quota, including on a stack
    // previously seeded with the original three Realms under the Work owner.
    const steward = sessions[index + 1]!;
    const receipt = await optional('Space / Realm creation', () => api.post<SpaceReceipt>('/v1/spaces', {
      profile: 'space-realm-v1', name: realm.name, capabilities: ['realm'],
      actingSubject: steward.actingSubject }, steward.token, seedKey('realm', realm.id)));
    if (receipt) createdRealms.push({ id: realm.id, receipt, steward });
  }
  const seededZones: string[] = [];
  for (const realm of realms) {
    const parent = createdRealms.find(item => item.id === realm.id);
    if (!parent) continue;
    const collection = `https://rezics.com/id/${stableId(`curated:${realm.id}`)}`;
    const zone = `https://rezics.com/id/${stableId(`zone:${realm.id}`)}`;
    await grantCuratedCollectionSeed(operatorInput, collection);
    const curated = await api.post<{ structure: string; revision: string }>('/v1/collections', {
      collection, name: `${realm.name} · Featured`, disclosure: 'public',
      actingSubject: owner.actingSubject }, ownerToken, seedKey('curated-collection', realm.id));
    await api.post(`/v1/collections/${collection.slice(-36)}/changes`, {
      expectedHead: curated.revision, actingSubject: owner.actingSubject,
      operations: realm.featured.map(work => ({ op: 'insert', role: 'member',
        parent: curated.structure, position: 'last',
        target: created.get(work)!.work, selection: { mode: 'follow-context' } })),
    }, ownerToken, seedKey('curated-members', realm.id));
    const stewardInput = { ...operatorInput, ownerAccountSubject: parent.steward.accountId,
      actingSubject: parent.steward.actingSubject };
    await grantOfficialZoneSeed(stewardInput, zone);
    await api.post('/v1/zones', {
      zone, space: parent.receipt.space, disclosure: 'public',
      actingSubject: parent.steward.actingSubject,
    }, parent.steward.token, seedKey('zone', realm.id));
    const currentZone = await api.get<{ revision: string; configuration: {
      defaultRealm: string | null; official: { routeSegment: string } | null;
      presentation: unknown } }>(
      `/v1/zones/${zone.slice(-36)}/configuration?actingSubject=${encodeURIComponent(parent.steward.actingSubject)}`,
      parent.steward.token);
    const preset = realm.preset;
    const desiredZone = { defaultRealm: parent.receipt.realm,
      official: { routeSegment: realm.id },
      presentation: { ...DEFAULT_ZONE_PRESENTATION, preset, tokens: ZONE_PRESETS[preset],
        navigation: [{ label: realm.name, href: `/r/${realm.id}` }],
        modules: [{ id: 'featured', type: 'editorial-list', title: 'Featured works',
          source: { kind: 'collection', collection }, options: { layout: 'covers', limit: 12 } }] } };
    if (!isDeepStrictEqual({ defaultRealm: currentZone.configuration.defaultRealm,
      official: currentZone.configuration.official, presentation: currentZone.configuration.presentation }, desiredZone)) {
      await operatorSession.api.put(`/v1/zones/${zone.slice(-36)}/configuration`, {
        expectedHead: currentZone.revision, actingSubject: parent.steward.actingSubject,
        ...desiredZone }, operatorSession.token,
      seedKey('official-zone', `${realm.id}:${currentZone.revision.slice(-36)}`));
    }
    seededZones.push(zone);
  }
  const original = created.get('pride');
  const translation = created.get('pride-zh');
  if (original && translation) await optional('Translation link', () => api.post('/v1/translation-links', {
    profile: 'translation-link-v1', targetWork: translation.work,
    targetMainVersion: translation.mainVersion, targetMainRevision: translation.mainRevision,
    sourceWork: original.work, sourceMainVersion: original.mainVersion,
    sourceMainRevision: original.mainRevision, status: 'third-party', contentLanguage: 'zh-Hans',
    translator: owner.actingSubject, publisher: owner.actingSubject,
    evidence: 'https://www.gutenberg.org/ebooks/1342',
    actingSubject: owner.actingSubject }, ownerToken, seedKey('translation', 'pride-zh')));

  let publishedCount = 0;
  let selectedCount = 0;
  let commentCount = 0;
  let replyCount = 0;
  for (const excerpt of works.filter(work => work.excerpt)) {
    const target = created.get(excerpt.id)!;
    const body = excerpt.excerpt!;
    const contribution = await optional('Text contribution', () => api.post<ContributionReceipt>(
      '/v1/contributions', { profile: 'text-contribution-v1', work: target.work,
        language: excerpt.language, body, actingSubject: owner.actingSubject },
      ownerToken, seedKey('contribution', excerpt.id)));
    if (contribution) {
      if (excerpt.id === 'serial-ch3') continue; // A draft for a moderation review queue.
      const published = await optional('Contribution publication', () => api.post<PublicationReceipt>(
        '/v1/contribution-publications', { profile: 'text-publication-v1',
          contribution: contribution.contribution, expectedDraftHead: contribution.draftRevision,
          expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
          actingSubject: owner.actingSubject }, ownerToken, seedKey('publication', excerpt.id)));
      const selected = published && await optional('Main selection', () => api.post('/v1/publication-selections', {
        profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: target.mainVersion },
        work: target.work, contribution: contribution.contribution,
        publicationDecision: published.publicationDecision, expectedSelectionHead: null,
        selectionBasis: 'main-maintainer', actingSubject: owner.actingSubject },
      ownerToken, seedKey('selection', excerpt.id)));
      if (published) publishedCount++;
      if (selected) selectedCount++;
      if (published) {
        const replyTarget = { id: `comment:${excerpt.id}`, work: target.work,
          revision: contribution.draftRevision, language: 'en' };
        const comment = await optional('Member comment', () => seedReply(api, sessions[1] ?? owner,
          replyTarget, `I saved this passage from ${excerpt.title} to discuss with the reading group.`));
        if (comment) {
          commentCount++;
          const reply = await optional('Member reply', () => seedReply(api, sessions[2] ?? owner,
            { ...replyTarget, id: `response:${excerpt.id}` },
            'Which detail in this passage stood out to you?', comment));
          if (reply) replyCount++;
        }
      }
    }
  }
  for (const person of sessions) await optional('Personal collection', () => api.post('/v1/collections', {
    collection: `https://rezics.com/id/${stableId(`collection:${person.id}`)}`,
    name: `${people.find(item => item.id === person.id)!.name} · Reading shelf`,
    disclosure: 'public', actingSubject: person.actingSubject },
  person.token, seedKey('collection', person.id)));

  for (const [index, person] of sessions.entries()) {
    const shelf = [
      { id: 'pride', status: 'read', startedOn: '2026-01-02', finishedOn: '2026-01-12' },
      { id: 'alice', status: 'reading', startedOn: null, finishedOn: null },
      { id: 'jane-eyre', status: 'want-to-read', startedOn: null, finishedOn: null },
    ] as const;
    const choice = shelf[index % shelf.length]!;
    const target = created.get(choice.id);
    if (!target) continue;
    await optional('Reading status', () => api.put(
      `/v1/works/${target.work.slice(-36)}/reader-status`,
      { actingSubject: person.actingSubject, expectedVersion: 0, status: choice.status,
        startedOn: choice.startedOn, finishedOn: choice.finishedOn },
      person.token, seedKey('reading-status', `${person.id}:${choice.id}`)));
  }

  const chaptersReady = await optional('Home chapter Content', () =>
    prepareHomeV2Chapters(api, owner, created, operatorInput));
  if (chaptersReady) await optional('Chapter reading progress', () =>
    seedChapterProgress(api, owner, sessions, created));

  const managed = createdRealms.find(realm => realm.id === 'fiction');
  if (managed) await optional('Realm moderation team and queue', () => seedRealmManagement(api,
    managed.receipt.realm, managed.steward,
    sessions.filter(session => session.id !== managed.steward.id).slice(0, 2),
    [...created.values()]));

  const feed = await optional('Home follows and votes', () => seedFeed(api, sessions, createdRealms));
  if (feed) console.log(`Home: ${feed.activities} activities, ${feed.followed} follows, ${feed.votes} votes.`);
  await optional('Home Continue and new activity', () => seedHomeV2(api, sessions, created, createdRealms));

  const search = await optional('Public search', () => fetch(`${endpoints.main}/v1/queries`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      profile: 'public-main-phrase-v1', phrase: 'Pride and Prejudice', language: null }) }));
  if (search && !search.ok) findings.add(`Public search: HTTP ${search.status} ${
    (await search.json() as { code?: string }).code ?? 'unknown'}`);
  const recent = await optional('Public Work list', () => fetch(`${endpoints.main}/v1/works?limit=5`));
  if (recent && !recent.ok) findings.add(`Public Work list: HTTP ${recent.status}`);
  else if (recent && (await recent.json() as { items?: unknown[] }).items?.length === 0) {
    findings.add('Public Work list: zero visible Works; metadata-only records need a selected publication');
  }

  console.log(`\nSeeded ${created.size} Works, ${createdRealms.length} Realms, ${seededZones.length} official Zones, ${people.length} Account users, ${agentCount} Agents, ${publishedCount} published contributions, ${selectedCount} Main selections, ${commentCount} comments, ${replyCount} replies.`);
  console.log('Demo sign-in credentials:');
  for (const person of people) console.log(`  ${person.name}: ${person.email} / ${person.password}`);
  console.log('Search URLs:');
  for (const id of ['pride', 'journey-west', 'dumplings']) {
    const work = works.find(item => item.id === id)!;
    const receipt = created.get(id)!;
    console.log(`  http://localhost:3000/works/${receipt.workRevision.split('/').at(-1)}`);
    console.log(`  http://localhost:3000/search?q=${encodeURIComponent(work.title)}`);
  }
  for (const realm of createdRealms) console.log(`  Realm API: ${endpoints.main}/v1/spaces/${realm.receipt.space.split('/').at(-1)}`);
  if (findings.size) {
    console.log('Public API gaps or unavailable outcomes:');
    for (const finding of findings) console.log(`  ${finding}`);
  }
  return findings.size === 0 && createdRealms.length === realms.length
    && seededZones.length === realms.length;
}

if (import.meta.main) {
  try { if (!await run(parseOptions(process.argv.slice(2)))) process.exitCode = 2; }
  catch (error) { console.error(describe(error)); process.exitCode = 1; }
}
