import { readFileSync } from 'node:fs';
import { ZONE_PRESETS } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { type SeedApi } from './api.ts';
import { officialTheme } from './official-plan.ts';
import { seedOfficialThemes } from './official-theme-step.ts';
import {
  grantCuratedCollectionSeed,
  grantHomeSeedAuthority,
  grantOfficialZoneSeed,
} from './operator.ts';
import { seedKey } from './plan.ts';
import { readOrCreateOfficialZone, updateOfficialZonePresentation } from './zones.ts';
import {
  afterCatchUp,
  refreshSeedTokens,
  stableId,
  type ContributionReceipt,
  type PublicationReceipt,
  type SeedState,
  type SpaceReceipt,
  type WorkReceipt,
} from './state.ts';

const short = (iri: string) => iri.slice(-36);
const iri = (name: string) => `https://rezics.com/id/${stableId(name)}`;
const slug = 'franchise-wiki';
const spec = JSON.parse(
  readFileSync(new URL('../../../config/zones/franchise-wiki.json', import.meta.url), 'utf8'),
) as {
  name: string;
  language: string;
  routeSegment: string;
  preset: 'editorial';
  navigation: { label: string; href: string }[];
  mounts: { id: string; name: string; routeSegment: string }[];
};

export const wikiChapterLabels = Array.from({ length: 51 }, (_, index) =>
  index === 50
    ? 'Chapter 51: 遠方 — The last lantern'
    : `Chapter ${index + 1}: Lantern journal ${index + 1}`,
);
export const wikiZone = iri(`zone:${slug}`);
const collections = Object.fromEntries(
  spec.mounts.map((mount) => [mount.id, iri(`wiki-collection:${mount.id}`)]),
);

interface WikiPort {
  api: Pick<SeedApi, 'post' | 'get' | 'getPublic'>;
  official: Pick<SeedApi, 'get' | 'put'>;
  actor: string;
  token: string;
  officialToken: string;
  prepareWork(work: WorkReceipt): Promise<void>;
}
interface Occurrence {
  role: string;
  target?: string;
  sourceKey?: string;
}
interface StructurePage {
  structure: string;
  revision: string;
  occurrences: Occurrence[];
  next: string | null;
}

/** Traverse the owner's immutable pages before changing its head. */
async function inventory(port: WikiPort, path: string): Promise<StructurePage> {
  const query = new URLSearchParams({ actingSubject: port.actor, limit: '100' });
  const first = await port.api.get<StructurePage>(`${path}?${query}`, port.token);
  const result = { ...first, occurrences: [...first.occurrences] };
  const cursors = new Set<string>();
  let next = first.next;
  while (next) {
    if (cursors.has(next)) throw new Error(`Wiki inventory repeats a cursor: ${path}`);
    cursors.add(next);
    query.set('after', next);
    const page = await port.api.get<StructurePage>(`${path}?${query}`, port.token);
    if (page.revision !== first.revision)
      throw new Error(`Wiki inventory changed during traversal: ${path}`);
    result.occurrences.push(...page.occurrences);
    next = page.next;
  }
  return result;
}

async function publish(port: WikiPort, key: string, title: string, body: string) {
  const { api, actor, token } = port;
  const work = await api.post<WorkReceipt>(
    '/v1/works',
    {
      profile: 'metadata-only-v1',
      title,
      language: 'en',
      semanticTypes: ['https://schema.org/Book'],
      authoring: 'own-work',
      actingSubject: actor,
    },
    token,
    seedKey('wiki-work', key),
  );
  await port.prepareWork(work);
  const contribution = await api.post<ContributionReceipt>(
    '/v1/contributions',
    {
      profile: 'text-contribution-v1',
      work: work.work,
      language: 'en',
      body,
      actingSubject: actor,
    },
    token,
    seedKey('wiki-contribution', key),
  );
  const publication = await api.post<PublicationReceipt>(
    '/v1/contribution-publications',
    {
      profile: 'text-publication-v1',
      contribution: contribution.contribution,
      expectedDraftHead: contribution.draftRevision,
      expectedPublicationHead: null,
      rightsBasis: 'original-contribution',
      disclosure: 'public',
      actingSubject: actor,
    },
    token,
    seedKey('wiki-publication', key),
  );
  await api.post(
    '/v1/publication-selections',
    {
      profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: work.mainVersion },
      work: work.work,
      contribution: contribution.contribution,
      publicationDecision: publication.publicationDecision,
      expectedSelectionHead: null,
      selectionBasis: 'main-maintainer',
      actingSubject: actor,
    },
    token,
    seedKey('wiki-selection', key),
  );
  return work;
}

/** Stable creation receipts and current inventories make a fresh or interrupted seed replayable.
 * O(chapters + inventory pages + mounts) reads, plus one Zone read before create.
 * Chapter writes are batches of at most 16. */
export async function applyOfficialWiki(port: WikiPort) {
  const { api, actor, token } = port;
  const space = await api.post<SpaceReceipt>(
    '/v1/spaces',
    {
      profile: 'space-realm-v2',
      name: spec.name,
      language: spec.language,
      handle: spec.routeSegment,
      capabilities: ['realm'],
      actingSubject: actor,
    },
    token,
    seedKey('wiki-space', slug),
  );
  await readOrCreateOfficialZone(api, {
    zone: wikiZone,
    space: space.space,
    actor,
    token,
    key: seedKey('wiki-zone', slug),
    name: spec.name,
    language: spec.language,
  });
  const story = await publish(
    port,
    'story',
    'The Lantern Atlas',
    'An original demo story. A mapmaker follows fifty-one lanterns across an archipelago, collecting the journals left at each harbour.',
  );
  const chapter = await publish(
    port,
    'journal',
    'The Lantern Atlas: harbour journal',
    'The lantern keeper opened the journal. Every traveller had drawn the same island in a different place. She lit the lamp and began a new map.',
  );
  const composition = await api.post<{ structure: string }>(
    '/v1/compositions',
    {
      profile: 'book-composition',
      work: story.work,
      mainVersion: story.mainVersion,
      actingSubject: actor,
    },
    token,
    seedKey('wiki-composition', 'story'),
  );
  const contents = await inventory(port, `/v1/compositions/${short(composition.structure)}`);
  const held = new Set(
    contents.occurrences.filter((item) => item.role === 'chapter').map((item) => item.sourceKey),
  );
  const missing = wikiChapterLabels.flatMap((value, index) => {
    const sourceKey = `official-wiki:chapter:${index + 1}`;
    return held.has(sourceKey)
      ? []
      : [
          {
            op: 'insert',
            parent: composition.structure,
            role: 'chapter',
            position: 'last',
            target: chapter.work,
            sourceKey,
            label: { value, language: 'en' },
          },
        ];
  });
  let head = contents.revision;
  for (let at = 0; at < missing.length; at += 16) {
    const changed = await api.post<{ revision: string }>(
      `/v1/compositions/${short(composition.structure)}/changes`,
      {
        profile: 'book-composition',
        expectedHead: head,
        actingSubject: actor,
        operations: missing.slice(at, at + 16),
      },
      token,
      seedKey('wiki-chapters', short(head)),
    );
    head = changed.revision;
  }
  for (const mount of spec.mounts) {
    const collection = collections[mount.id]!;
    await api.post(
      '/v1/collections',
      {
        collection,
        name: mount.name,
        language: spec.language,
        disclosure: 'public',
        actingSubject: actor,
      },
      token,
      seedKey('wiki-collection', mount.id),
    );
    if (mount.id === 'franchise') {
      const page = await inventory(port, `/v1/collections/${short(collection)}`);
      if (!page.occurrences.some((item) => item.role === 'member' && item.target === story.work))
        await api.post(
          `/v1/collections/${short(collection)}/changes`,
          {
            expectedHead: page.revision,
            actingSubject: actor,
            operations: [
              {
                op: 'insert',
                parent: page.structure,
                role: 'member',
                position: 'last',
                target: story.work,
                selection: { mode: 'follow-context' },
              },
            ],
          },
          token,
          seedKey('wiki-member', short(page.revision)),
        );
    }
    const page = await api.get<{
      revision: string;
      mounts: { target: string; qualifier?: { routeSegment: string }; state: string }[];
    }>(
      `/v1/zones/${short(wikiZone)}?${new URLSearchParams({ actingSubject: actor, limit: '100' })}`,
      token,
    );
    const current = page.mounts.find(
      (item) => item.qualifier?.routeSegment === mount.routeSegment && item.state !== 'removed',
    );
    if (current && current.target !== collection)
      throw new Error(`Wiki mount ${mount.routeSegment} has another target`);
    if (!current)
      await api.post(
        `/v1/zones/${short(wikiZone)}/mounts`,
        {
          expectedHead: page.revision,
          target: collection,
          routeSegment: mount.routeSegment,
          disclosure: 'public',
          position: 'last',
          actingSubject: actor,
        },
        token,
        seedKey('wiki-mount', `${mount.id}:${short(page.revision)}`),
      );
  }
  const configuration = await api.get<{
    revision: string;
    configuration: {
      space?: unknown;
      defaultRealm?: unknown;
      official?: unknown;
      presentation?: unknown;
    };
  }>(
    `/v1/zones/${short(wikiZone)}/configuration?${new URLSearchParams({ actingSubject: actor })}`,
    token,
  );
  const recorded = configuration.configuration;
  const officialMarker = recorded.official;
  await updateOfficialZonePresentation(port.official, {
    zone: wikiZone,
    actor,
    token: port.officialToken,
    head: {
      revision: configuration.revision,
      configuration: {
        space: typeof recorded.space === 'string' ? recorded.space : null,
        defaultRealm: typeof recorded.defaultRealm === 'string' ? recorded.defaultRealm : null,
        official: officialMarker !== null && typeof officialMarker === 'object' && !Array.isArray(officialMarker)
          ? {} : null,
        presentation: recorded.presentation ?? null,
      },
    },
    defaultRealm: space.realm,
    candidates: [{
      variant: '',
      presentation: {
        profile: 'zone-presentation-v2',
        preset: spec.preset,
        tokens: ZONE_PRESETS[spec.preset],
        navigation: spec.navigation,
        slides: [],
        official: { theme: officialTheme(slug) },
        modules: spec.mounts.map((mount) => ({
          id: mount.id,
          type: 'shelf',
          title: mount.name,
          source: { kind: 'collection', collection: collections[mount.id]! },
          options: { limit: 12 },
        })),
      },
    }],
    key: (revision) => seedKey('wiki-configuration', short(revision)),
  });
  return {
    space: space.space,
    zone: wikiZone,
    work: story.work,
    chapters: wikiChapterLabels.length,
  };
}

/** Reuse the dev workflow's local, scoped fixture authority; all content uses public Main operations. */
export async function seedOfficialWiki(state: SeedState): Promise<void> {
  const owner = state.sessions.find((session) => session.id === 'mei');
  if (!owner || !state.operatorInput || !state.operatorSession)
    throw new Error('Official wiki seed needs the local fixture operator and writer');
  await refreshSeedTokens(state);
  const input = {
    ...state.operatorInput,
    ownerAccountSubject: owner.accountId,
    actingSubject: owner.actingSubject,
  };
  await grantOfficialZoneSeed(input, wikiZone);
  for (const collection of Object.values(collections))
    await grantCuratedCollectionSeed(input, collection);
  const result = await applyOfficialWiki({
    api: state.api,
    official: state.operatorSession.api,
    actor: owner.actingSubject,
    token: owner.token,
    officialToken: state.operatorSession.token,
    prepareWork: (work) =>
      grantHomeSeedAuthority(input, [
        { action: 'work.read', scope: `work:read:${work.work}` },
        { action: 'work.edit', scope: `work:edit:${work.work}` },
      ]),
  });
  await seedOfficialThemes(state, [slug]);
  await afterCatchUp(async () => {
    const positions = await state.api.getPublic<{ items: { labels: { value: string }[] }[] }>(
      `/v1/reading-positions/${short(result.work)}?${new URLSearchParams({ q: wikiChapterLabels.at(-1)! })}`,
    );
    if (
      !positions.items.some((item) =>
        item.labels.some((label) => label.value === wikiChapterLabels.at(-1)),
      )
    )
      throw new Error('Official wiki story has no published final chapter position');
  });
  console.log(`Official wiki: ${result.chapters} chapter positions at /z/${slug}/franchise.`);
}
