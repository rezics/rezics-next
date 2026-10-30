import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';
import {
  staticZoneGuideFake as staticGuide,
  staticZoneHomeFake as staticHome,
  staticZoneOwnerFake as staticOwnerHome,
} from '../../zones/static-fakes';
import subjectPage from '../recorded/zone-subject-page.json';
import subjectReactions from '../recorded/subject-reactions.json';

const zoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const hiddenZoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02';
const withinBudgetZoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e03';
const preparingZoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e04';
const unavailableZoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e05';
const alternateZoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06';
const recoveringZoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e07';
const revokedZoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e08';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const staticZoneId = staticHome.zone.id;
const staticOwnerZoneId = staticOwnerHome.zone.id;
const recoveringReads = new Map<string, number>();

type ZoneTarget = { route: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function homeDocument() {
  const title = {
    en: 'Field Notes',
    'zh-Hans': '田野札记',
  };
  const description = {
    en: 'A public page from the native Zone configuration.',
    'zh-Hans': '原生区域页面内容。',
  };
  return {
    root: { props: {} },
    content: [
      { type: 'Heading', props: { id: 'zone-title', level: 1, text: title } },
      { type: 'Text', props: { id: 'zone-intro', text: description } },
      {
        type: 'LinkGrid',
        props: {
          id: 'featured-subject',
          links: [{ href: `/subjects/${subjectId}/kokoro`, label: { en: 'Kokoro', 'zh-Hans': '心' } }],
        },
      },
    ],
  };
}

function guideDocument() {
  return {
    root: {
      props: {
        appearance: { density: 'comfortable', radius: 'lg', surface: 'flat', cover: 'portrait', headingScale: 'md' },
      },
    },
    content: [
      { type: 'Heading', props: { id: 'guide-title', level: 1, text: { en: 'Guide', 'zh-Hans': '指南' } } },
      {
        type: 'Text',
        props: {
          id: 'guide-copy',
          text: { en: 'A second declared static page.', 'zh-Hans': '另一个已配置的静态页面。' },
        },
      },
    ],
  };
}

function zoneResponse(id: string, target: ZoneTarget): KernelRecording {
  const alternate = id === alternateZoneId;
  const route = target.route;
  if (route !== '' && route !== 'guide') return problem(404, { 'cache-control': 'no-store' });
  return {
    status: 200,
    profile: 'sha256:zone-story',
    template: { scope: 'route', key: route || null },
    document: route === 'guide' ? guideDocument() : homeDocument(),
    reads: {},
    zone: {
      id,
      revision: '1',
      labels: alternate
        ? { en: 'Open Archive', 'zh-Hans': '开放档案库' }
        : { en: 'Field Notes', 'zh-Hans': '田野札记' },
      visibility: 'public',
      appearance: alternate
        ? { density: 'comfortable', radius: 'lg', surface: 'flat', cover: 'portrait', headingScale: 'md' }
        : { density: 'compact', radius: 'sm', surface: 'cards', cover: 'square', headingScale: 'lg' },
      navigation: [{ route: '' }, { route: 'guide' }],
    },
  };
}

function problem(status: number, headers?: Record<string, string>): KernelRecording {
  return {
    status,
    headers,
    type: `https://rezics.com/problems/${status === 404 ? 'not_found' : 'presentation_not_ready'}`,
    title: status === 404 ? 'Not Found' : 'Service Unavailable',
    code: status === 404 ? 'not_found' : 'presentation_not_ready',
    retryable: status === 503,
    effect_status: 'not_applicable',
    request_id: `zone-${status}`,
  };
}

async function response(request: Request, match: RegExpExecArray | null): Promise<KernelRecording | undefined> {
  const id = match?.[1] ? decodeURIComponent(match[1]) : undefined;
  if (!id) return undefined;
  if (id === hiddenZoneId) return problem(404, { 'cache-control': 'no-store' });
  if (id === unavailableZoneId) return problem(503, { 'cache-control': 'no-store', 'retry-after': '1' });

  const url = new URL(request.url);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { status: 400, code: 'invalid_request' };
  }
  const target = isRecord(body) ? body.target : undefined;
  if (!isRecord(target)) return { status: 400, code: 'invalid_request' };
  if (typeof target.route !== 'string') return problem(404, { 'cache-control': 'no-store' });
  if (id === staticOwnerZoneId)
    return request.headers.has('authorization') && target.route === ''
      ? { status: 200, ...staticOwnerHome }
      : problem(404, { 'cache-control': 'no-store' });
  if (id === staticZoneId) {
    const recording = target.route === '' ? staticHome : target.route === 'guide' ? staticGuide : undefined;
    return recording ? { status: 200, ...recording } : problem(404, { 'cache-control': 'no-store' });
  }
  const cursor = url.searchParams.get('cursor');
  if (id === recoveringZoneId) {
    const count = recoveringReads.get(id) ?? 0;
    recoveringReads.set(id, count + 1);
    if (count === 0) return problem(503, { 'cache-control': 'no-store', 'retry-after': '3' });
    if (cursor !== null) return { status: 400, code: 'invalid_request' };
  }
  if (id === revokedZoneId) {
    const index = cursor === null ? 0 : Number(cursor.replace(/^cursor-/, ''));
    if (index >= 5) return problem(404, { 'cache-control': 'no-store' });
    return {
      status: 202,
      headers: { 'cache-control': 'no-store', 'retry-after': '2' },
      next: `cursor-${index + 1}`,
    };
  }
  const isContinuingZone = id === withinBudgetZoneId || id === preparingZoneId;
  if (isContinuingZone) {
    if (id === withinBudgetZoneId && cursor === 'cursor-2') return zoneResponse(id, target as unknown as ZoneTarget);
    if (id === preparingZoneId && cursor === 'cursor-5') return zoneResponse(id, target as unknown as ZoneTarget);
    const index = cursor === null ? 0 : Number(cursor.replace(/^cursor-/, ''));
    return {
      status: 202,
      headers: { 'cache-control': 'no-store', 'retry-after': '0' },
      next: `cursor-${index + 1}`,
    };
  }
  if (id !== zoneId && id !== alternateZoneId && id !== recoveringZoneId)
    return problem(404, { 'cache-control': 'no-store' });
  return zoneResponse(id, target as unknown as ZoneTarget);
}

async function subjectPageResponse(request: Request): Promise<KernelRecording | undefined> {
  let target: unknown;
  try {
    const body = await request.json();
    target = isRecord(body) ? body.target : undefined;
  } catch {
    return undefined;
  }
  if (!isRecord(target)) return undefined;
  if (target.subject !== subjectId) return undefined;
  if (target.view !== undefined && target.view !== 'overview' && target.view !== 'details') return undefined;
  return {
    ...subjectPage,
    status: 200,
    subject: subjectId,
    views: ['overview', 'details'],
  };
}

const route: FakeRoute = {
  method: 'POST',
  path: /^\/v1\/zones\/([^/]+):readPage$/,
  story: ({ request, match }) => response(request, match),
  fixture: ({ request, match }) => response(request, match),
};

const subjectPageRoute: FakeRoute = {
  method: 'POST',
  path: '/v1/pages:read',
  story: ({ request }) => subjectPageResponse(request),
};

const subjectReactionsRoute: FakeRoute = {
  method: 'GET',
  path: /^\/v1\/subjects\/([^/]+)\/reactions$/,
  story: ({ match }) => (match?.[1] === subjectId ? subjectReactions : undefined),
};

export const routes = [route, subjectPageRoute, subjectReactionsRoute];
