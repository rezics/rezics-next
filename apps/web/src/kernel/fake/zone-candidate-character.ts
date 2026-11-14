import type { NativePageBody } from '../../features/pages/page-read-failure';
import {
  characterCandidateCharacters,
  characterCandidatePage,
  characterCandidateProfile,
  characterCandidateSubjectRead,
  characterCandidateZoneIds,
  type CharacterCandidateHome,
} from '../../zones/candidates/character';
import type { KernelRecording } from '../fake';
import type { FakeRoute } from '../fake-modules';

type CharacterCandidateState =
  | { id: string; kind: CharacterCandidateHome }
  | { id: string; kind: 'platform-closed' | 'semantic-not-ready' | 'private' | 'missing' };

const zones: CharacterCandidateState[] = [
  { id: characterCandidateZoneIds.preview, kind: 'preview' },
  { id: characterCandidateZoneIds.readyEmpty, kind: 'ready-empty' },
  { id: characterCandidateZoneIds.sparse, kind: 'sparse' },
  { id: characterCandidateZoneIds.platformClosed, kind: 'platform-closed' },
  { id: characterCandidateZoneIds.semanticNotReady, kind: 'semantic-not-ready' },
  { id: characterCandidateZoneIds.private, kind: 'private' },
  { id: characterCandidateZoneIds.missing, kind: 'missing' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function requestBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const body: unknown = await request.json().catch(() => undefined);
  return isRecord(body) ? body : undefined;
}

function pageRecording(page: ReturnType<typeof characterCandidatePage>): KernelRecording {
  return { status: 200, ...page };
}

function notFoundRecording(): KernelRecording {
  return { status: 404, headers: { 'cache-control': 'no-store' }, code: 'not_found' };
}

function nativeSubjectRecording(subjectId: string): KernelRecording | undefined {
  const character = characterCandidateCharacters.find(({ id }) => id === subjectId);
  if (!character) return;

  const zonePage = characterCandidatePage(characterCandidateZoneIds.preview, 'preview', character.id);
  const page = {
    subject: character.id,
    profile: characterCandidateProfile,
    template: zonePage.template,
    document: zonePage.document,
    reads: zonePage.reads,
  } satisfies Pick<NativePageBody, 'subject' | 'profile' | 'template' | 'document' | 'reads'>;

  return { status: 200, ...page };
}

const zoneRoute: FakeRoute = {
  method: 'POST',
  path: /^\/v1\/zones\/([^/]+):readPage$/,
  story: async ({ request, match }) => {
    const zone = zones.find(({ id }) => id === match?.[1]);
    if (!zone) return;

    if (zone.kind === 'platform-closed')
      return {
        status: 403,
        headers: { 'cache-control': 'no-store' },
        code: 'platform_closed',
      };
    if (zone.kind === 'semantic-not-ready')
      return {
        status: 503,
        headers: { 'cache-control': 'no-store', 'retry-after': '1' },
        code: 'semantic_not_ready',
      };
    if (zone.kind === 'private' || zone.kind === 'missing') return notFoundRecording();

    const body = await requestBody(request);
    if (!body || !isRecord(body.target)) return notFoundRecording();
    const target = body.target;

    if (typeof target.route === 'string') {
      if (target.route !== '') return notFoundRecording();
      return pageRecording(characterCandidatePage(zone.id, zone.kind));
    }

    if (typeof target.subject === 'string') {
      if (zone.kind !== 'preview' || (target.view !== undefined && target.view !== 'overview'))
        return notFoundRecording();
      if (!characterCandidateCharacters.some(({ id }) => id === target.subject)) return notFoundRecording();
      return pageRecording(characterCandidatePage(zone.id, 'preview', target.subject));
    }

    return notFoundRecording();
  },
};

const nativePageRoute: FakeRoute = {
  method: 'POST',
  path: '/v1/pages:read',
  story: async ({ request }) => {
    const body = await requestBody(request);
    const target = body?.target;
    if (!isRecord(target) || typeof target.subject !== 'string') return;
    return nativeSubjectRecording(target.subject);
  },
};

const subjectReadRoute: FakeRoute = {
  method: 'GET',
  path: /^\/v1\/subjects\/([^/]+)$/,
  story: ({ match }) => {
    const subject = characterCandidateCharacters.find(({ id }) => id === match?.[1]);
    return subject ? { status: 200, ...characterCandidateSubjectRead(subject) } : undefined;
  },
};

export const routes: FakeRoute[] = [nativePageRoute, subjectReadRoute, zoneRoute];
