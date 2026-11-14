import type { NativePageBody } from '../../features/pages/page-read-failure';
import {
  characterCandidateCharacters,
  characterCandidatePage,
  characterCandidateProfile,
  characterCandidateZoneIds,
  characterCandidateSubjectDocument,
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

function nativeSubjectRecording(subjectId: string): KernelRecording | undefined {
  const character = characterCandidateCharacters.find(({ id }) => id === subjectId);
  if (!character) return;

  const page = {
    subject: character.id,
    profile: characterCandidateProfile,
    template: { scope: 'generic', key: null },
    document: characterCandidateSubjectDocument(character),
    reads: {},
  } satisfies Pick<NativePageBody, 'subject' | 'profile' | 'template' | 'document' | 'reads'>;

  return { status: 200, ...page };
}

function zoneRoute(zone: CharacterCandidateState): FakeRoute {
  return {
    method: 'POST',
    path: `/v1/zones/${zone.id}:readPage`,
    story: async ({ request }) => {
      const body = await requestBody(request);
      if (!body || !isRecord(body.target)) return;
      const target = body.target;

      if ('route' in target) {
        if (target.route !== '') return;
      } else if (zone.kind === 'preview' && typeof target.subject === 'string') {
        if (!characterCandidateCharacters.some(({ id }) => id === target.subject)) return;
        return pageRecording(characterCandidatePage(zone.id, 'preview', target.subject));
      } else {
        return;
      }

      if (zone.kind === 'platform-closed') return { status: 403, code: 'platform_closed' };
      if (zone.kind === 'semantic-not-ready')
        return { status: 503, headers: { 'retry-after': '1' }, code: 'semantic_not_ready' };
      if (zone.kind === 'private' || zone.kind === 'missing') return { status: 404, code: 'not_found' };

      return pageRecording(characterCandidatePage(zone.id, zone.kind));
    },
  };
}

const characterPageRoute: FakeRoute = {
  method: 'POST',
  path: '/v1/pages:read',
  story: async ({ request }) => {
    const body = await requestBody(request);
    const target = body?.target;
    if (!isRecord(target) || typeof target.subject !== 'string') return;
    return nativeSubjectRecording(target.subject);
  },
};

export const routes: FakeRoute[] = [characterPageRoute, ...zones.map(zoneRoute)];
