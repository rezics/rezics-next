import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createSpace } from '../../../scripts/dev/seed/ln-vn-zones-step.ts';
import { officialTheme } from '../../../scripts/dev/seed/official-plan.ts';
import { approveOfficialPackage } from '../../../scripts/dev/seed/official-theme-step.ts';
import { stableId } from '../../../scripts/dev/seed/state.ts';
import { call, createCatalogueWork, publishCatalogueText, read, type SeedPort }
  from '../../../scripts/dev/seed/vn-catalogue-step.ts';
import { ZONE_PRESETS } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { ZoneBrowseProjection } from '../../../services/main/src/modules/zone-browse/store.ts';
import { WorkReadUnavailable } from '../../../services/main/src/modules/work/read-session.ts';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { openActorPlatformGroup } from './g-838-catalogue.ts';

export interface GamesCatalogue {
  handle: string;
  realm: string;
  works: { work: string; title: string }[];
  releases: { id: string; title: string; platform: string }[];
}

const run = process.env.REZICS_QA_RUN_ID;
const objectDirectory = process.env.MAIN_OBJECT_DIRECTORY;
const relayUrl = process.env.ACCOUNT_RELAY_DATABASE_URL;
if (!run || !objectDirectory || !relayUrl || !process.env.REZICS_WEB_AUTH_PRIVATE_PATH) {
  throw new Error('Games preparation requires the isolated browser QA stack');
}
const short = (iri: string) => iri.slice(-36);
const iri = (name: string) => `https://rezics.com/id/${stableId(`games-journeys:${name}`)}`;
const stack = await startMediaStack('games-journeys', { profileCredits: true });
const relay = new Pool({ connectionString: relayUrl });
try {
  for (const [prefix, key] of [['semantic/work/', 'workObjects'], ['semantic/structure/', 'structureObjects']] as const) {
    const objects = stack.objects(prefix);
    await objects.initialize();
    Object.assign(stack.env, { objectDirectory, [key]: objects });
  }
  const editor = await stack.member('games-catalogue-editor');
  const reviewer = await stack.member('games-package-reviewer');
  const requestFor = (token: string): SeedPort['request'] => async (method, path, body, key = randomUUID()) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await stack.call(method, path, { token, body, key });
      const text = await response.text();
      if (response.status !== 202) return { status: response.status, body: text ? JSON.parse(text) as unknown : null };
      await new Promise(done => setTimeout(done, 200));
    }
    throw new Error(`${method} ${path} stayed pending`);
  };
  const request = requestFor(editor.token);
  const port: SeedPort = { actingSubject: editor.actor, request,
    grant: async (scope, action) => { await editor.grant(scope, action); } };
  for (const [scope, action] of [
    ['work:create:root', 'work.create'], ['catalogue:verify:root', 'catalogue.verify'],
    ['space:create:root', 'space.create'],
  ] as const) await port.grant(scope, action);

  const zone = iri('zone');
  const { space, realm } = await createSpace(port, {
    id: 'games-journeys', name: 'Games', language: 'en', routeSegment: 'games', preset: 'editorial',
    mountSegment: 'catalogue', navigation: [], browse: [], announcement: '', sharedMember: '',
  }, zone);
  await port.grant(`zone:edit:${zone}`, 'zone.edit');
  await port.grant(`zone:official:${zone}`, 'zone.official');
  await call(port, 'POST', '/v1/zones', { zone, space, disclosure: 'public', name: 'Games',
    language: 'en', actingSubject: editor.actor }, 'games-journeys:zone');
  const configuration = await read<{ revision: string }>(port, `/v1/zones/${short(zone)}/configuration`);
  await call(port, 'PUT', `/v1/zones/${short(zone)}/configuration`, {
    expectedHead: configuration.revision, actingSubject: editor.actor, name: 'Games', language: 'en',
    defaultRealm: realm, official: {}, presentation: {
      profile: 'zone-presentation-v2', preset: 'editorial', tokens: ZONE_PRESETS.editorial,
      navigation: [{ label: 'Browse', href: '/browse' }], slides: [], modules: [],
      official: { theme: officialTheme('games') },
    },
  }, 'games-journeys:configuration');
  await port.grant(`publication:adopt:${realm}`, 'publication.adopt');

  const works: GamesCatalogue['works'] = [];
  let first: { work: string; mainVersion: string } | undefined;
  for (const [index, title] of ['Starfall Expedition', 'Starfall Tactics', 'Moonlit Garden'].entries()) {
    const created = await createCatalogueWork(port, { key: `games-journeys:work:${index}`, title,
      language: 'en', semanticType: 'https://schema.org/VideoGame' });
    first ??= created;
    for (const [scope, action] of [
      [`work:edit:${created.work}`, 'work.edit'], [`work:read:${created.work}`, 'work.read'],
      [`contribution:create:${created.work}`, 'contribution.create'],
      [`publication:select:${created.mainVersion}`, 'publication.select'],
    ] as const) await port.grant(scope, action);
    const published = await publishCatalogueText(port, created, `games-journeys:${index}`, 'en',
      `${title}: a game in the Games browser catalogue.`);
    await call(port, 'POST', '/v1/publication-selections', {
      profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: realm },
      work: created.work, mainVersion: created.mainVersion, contribution: published.contribution,
      publicationDecision: published.decision, expectedSelectionHead: null,
      selectionBasis: 'realm-manager-review', actingSubject: editor.actor,
    }, `games-journeys:adopt:${index}`);
    works.push({ work: created.work, title });
  }
  if (!first) throw new Error('Games catalogue has no Work');
  const realization = iri('original');
  const original = await call<{ revision: string }>(port, 'PUT',
    `/v1/works/${short(first.work)}/realizations/${short(realization)}`, {
      profile: 'realization-v1', id: realization, expectedHead: null, actingSubject: editor.actor,
      language: 'en', kind: 'original', translators: [], publishers: [],
      source: { kind: 'unresolved', work: first.work }, status: 'official', verification: 'verified',
      evidence: 'https://example.com/starfall-expedition',
    }, 'games-journeys:original');
  const releases: GamesCatalogue['releases'] = [];
  for (const [key, title, platform] of [
    ['pc', 'Starfall Expedition PC edition', 'PC'],
    ['console', 'Starfall Expedition console edition', 'Switch'],
  ] as const) {
    const id = iri(key);
    await call(port, 'PUT', `/v1/works/${short(first.work)}/releases/${short(id)}`, {
      profile: 'release-v2', id, expectedHead: null, actingSubject: editor.actor,
      kind: 'formal', status: 'official', titleLanguage: 'en', tracklistLanguage: null,
      title: { value: title, language: 'en' }, editionStatement: null, publisher: 'Starfall Studio',
      publicationYear: 2025, isbn13: null, originalUrl: null, fixedRelease: null,
      evidence: null, identifiers: [], platform, territory: null,
      coverage: [{ realization, revision: original.revision, completeness: 'complete' }],
    }, `games-journeys:release:${key}`);
    releases.push({ id, title, platform });
  }

  await openActorPlatformGroup(editor.principalId, 'executable-themes');
  await openActorPlatformGroup(reviewer.principalId, 'executable-themes');
  const theme = short(officialTheme('games'));
  for (const [scope, action] of [
    ['theme:create:root', 'theme.create'], [`theme:revise:${theme}`, 'theme.revise'],
    [`theme:activate:${theme}`, 'theme.activate'],
  ] as const) await editor.grant(scope, action);
  await reviewer.grant(`theme:review:${theme}`, 'theme.review');
  await approveOfficialPackage({ slug: 'games', zone, owner: editor.actor, reviewer: reviewer.actor,
    request, review: requestFor(reviewer.token) });
  const projection = new ZoneBrowseProjection(stack.accessPool, relay, stack.env);
  // Theme and publication relay deliveries can advance while the first cut is read.
  // Reconcile again only for a moved cut; deterministic preparation faults stay failures.
  for (let attempt = 0; ; attempt++) {
    try { await projection.backfill(); break; }
    catch (error) {
      if (attempt >= 30 || !(error instanceof WorkReadUnavailable)
        || !/^Zone browse (?:relay coverage|authoritative cut) changed during reconciliation$|^Zone browse recovery waiting for a stable cut$/.test(error.message)) {
        throw error;
      }
      await new Promise(done => setTimeout(done, 1_000));
    }
  }
  const directory = resolve('.temp/games-journeys', run);
  mkdirSync(directory, { recursive: true });
  const seeded: GamesCatalogue = { handle: 'games', realm, works, releases };
  writeFileSync(resolve(directory, 'seed.json'), JSON.stringify(seeded));
} finally {
  await relay.end();
  await stack.stop();
}
