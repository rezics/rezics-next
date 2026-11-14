import {
  planReads,
  platformRegistry,
  profileDigest,
  type CompositionDocument,
  type PresentationProfile,
} from '@rezics/composition';
import platformProfileJson from '@rezics/composition/profiles/platform.json' with { type: 'json' };
import type { ZonePageResponse, ZonePublic } from '../appearance';
import starterJson from '../../../../../packages/definitions/presentation/game/zone.json' with { type: 'json' };

type Starter = {
  labels: ZonePublic['labels'];
  pages: { route: string; document: CompositionDocument }[];
  scope: string[];
};

const starter = starterJson as unknown as Starter;
const profile = profileDigest(platformProfileJson as PresentationProfile);

export const videoGameZoneIds = {
  admittedPreview: '0193c000-0004-7000-8000-000000000000',
  platformClosed: '0193c000-0004-7000-8000-000000000001',
  semanticNotReady: '0193c000-0004-7000-8000-000000000002',
  readyEmpty: '0193c000-0004-7000-8000-000000000003',
  sparse: '0193c000-0004-7000-8000-000000000004',
  concealedPrivate: '0193c000-0004-7000-8000-000000000005',
  missing: '0193c000-0004-7000-8000-000000000006',
} as const;

export type VideoGameReadState = 'admitted-preview' | 'ready-empty' | 'sparse';

export type VideoGameWork = {
  id: string;
  label: string;
  description: string;
};

export const videoGameWorks: readonly VideoGameWork[] = [
  {
    id: '0193c100-0004-7000-8000-000000000001',
    label: 'Paper Comet',
    description: 'A fictional adventure game made for this development preview.',
  },
  {
    id: '0193c100-0004-7000-8000-000000000002',
    label: 'Cloud Orchard',
    description: 'A fictional puzzle game made for this development preview.',
  },
  {
    id: '0193c100-0004-7000-8000-000000000003',
    label: 'Clockwork Tide',
    description: 'A fictional strategy game made for this development preview.',
  },
];

const routeCopy: Record<string, string> = {
  '': 'Development preview, deferred: this configured VideoGame list uses fictional examples. It does not describe an official site or a public release catalogue.',
  'add-ons':
    'Static development-preview page for independently referable add-ons. This starter defines no add-on list here.',
  releases:
    'Static development-preview page for release-level details such as platform, language, and publication date. This starter defines no release list here.',
};

function withIntro(document: CompositionDocument, copy: string): CompositionDocument {
  const authored = structuredClone(document);
  const intro = authored.content.find((node) => node.type === 'Text' && node.props.id === 'intro');
  if (!intro || typeof intro.props.text !== 'string') throw new Error('The Video games starter intro is missing.');
  intro.props.text = copy;
  return authored;
}

const routeDocuments = Object.fromEntries(
  starter.pages.map(({ route, document }) => [route, withIntro(document, routeCopy[route] ?? routeCopy['']!)]),
) as Record<string, CompositionDocument>;

const homePlan = planReads(platformRegistry, routeDocuments['']!, { subject: null });
const homeReadKey = homePlan.nodes.works;
if (!homeReadKey) throw new Error('The Video games starter no longer plans its works list.');

export const videoGameCandidate = {
  profile,
  labels: starter.labels,
  routes: starter.pages.map(({ route }) => route),
  savedScopeIds: starter.scope,
  documents: routeDocuments,
} satisfies {
  profile: string;
  labels: ZonePublic['labels'];
  routes: readonly string[];
  savedScopeIds: readonly string[];
  documents: Record<string, CompositionDocument>;
};

function publicZone(id: string): ZonePublic {
  return {
    id,
    revision: '1',
    labels: videoGameCandidate.labels,
    primaryLanguage: 'en',
    visibility: 'public',
    appearance: {},
    navigation: videoGameCandidate.routes.map((route) => ({ route })),
  };
}

function searchBody(state: VideoGameReadState) {
  const works = state === 'admitted-preview' ? videoGameWorks : state === 'sparse' ? videoGameWorks.slice(0, 1) : [];
  return {
    subjects: works.map(({ id, label }) => ({
      id,
      type: 'schema:VideoGame',
      labels: { en: label },
      summary: null,
    })),
    next: null,
  };
}

export function videoGameZonePageResponse(
  zoneId: string,
  route: string,
  state: VideoGameReadState,
): ZonePageResponse | undefined {
  const document = videoGameCandidate.documents[route];
  if (!document) return undefined;
  return {
    profile: videoGameCandidate.profile,
    template: { scope: 'route', key: route },
    document,
    reads: route === '' ? { [homeReadKey]: { status: 200, body: searchBody(state) } } : {},
    zone: publicZone(zoneId),
  };
}

export type VideoGameSubjectResponse = Omit<ZonePageResponse, 'zone'> & { subject: string };

export function videoGameSubjectResponse(subjectId: string): VideoGameSubjectResponse | undefined {
  const work = videoGameWorks.find(({ id }) => id === subjectId);
  if (!work) return undefined;
  return {
    profile: videoGameCandidate.profile,
    template: { scope: 'type', key: 'schema:VideoGame' },
    document: {
      root: { props: {} },
      content: [
        { type: 'Heading', props: { id: 'game-title', text: work.label, level: 1 } },
        { type: 'Text', props: { id: 'game-preview', text: work.description } },
      ],
    },
    reads: {},
    subject: work.id,
  };
}

export function videoGameZoneSubjectResponse(zoneId: string, subjectId: string): ZonePageResponse | undefined {
  const subject = videoGameSubjectResponse(subjectId);
  return subject ? { ...subject, zone: publicZone(zoneId) } : undefined;
}
