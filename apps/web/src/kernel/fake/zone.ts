import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';
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
const recoveringReads = new Map<string, number>();

type ZoneTarget = { route: string } | { subject: string; view?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function homeDocument(zone: string) {
  const title = {
    en: 'A clear view of the collection',
    'zh-Hans': '从容查看收藏',
  };
  const description = {
    en: 'A considered shelf of stories, subjects, and reading paths.',
    'zh-Hans': '精心整理的故事、主题与阅读路径。',
  };
  const subjectHref = `/zones/${zone}/subjects/${subjectId}`;
  return {
    root: { props: {} },
    content: [
      { type: 'Heading', props: { id: 'zone-title', level: 1, text: title } },
      { type: 'Text', props: { id: 'zone-intro', text: description } },
      {
        type: 'LinkGrid',
        props: {
          id: 'mounted-collections',
          links: [
            {
              href: '/collections/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11',
              label: { en: 'Stories to revisit', 'zh-Hans': '值得重读的故事' },
            },
            {
              href: '/collections/0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e12',
              label: { en: 'New perspectives', 'zh-Hans': '新的视角' },
            },
          ],
        },
      },
      {
        type: 'LinkGrid',
        props: {
          id: 'featured-subject',
          links: [{ href: subjectHref, label: { en: 'Kokoro', 'zh-Hans': '心' } }],
        },
      },
    ],
  };
}

function subjectDocument(view?: string) {
  if (view === 'details')
    return {
      root: { props: {} },
      content: [
        {
          type: 'Heading',
          props: {
            id: 'zone-subject-details',
            level: 1,
            text: { en: 'Kokoro details in the Zone', 'zh-Hans': '专区中的《心》详情' },
          },
        },
        {
          type: 'Text',
          props: {
            id: 'zone-subject-details-copy',
            text: {
              en: 'The view keeps the Zone presentation and its page context.',
              'zh-Hans': '此视图保留专区的呈现方式和页面上下文。',
            },
          },
        },
      ],
    };
  const recorded = subjectPage.document as { root: { props: Record<string, unknown> }; content: unknown[] };
  return {
    ...recorded,
    root: {
      ...recorded.root,
      props: {
        ...recorded.root.props,
        appearance: {
          density: 'comfortable',
          radius: 'lg',
          surface: 'flat',
          cover: 'landscape',
          headingScale: 'md',
        },
      },
    },
  };
}

function zoneResponse(id: string, target: ZoneTarget): KernelRecording {
  const alternate = id === alternateZoneId;
  const isSubject = 'subject' in target;
  const view = isSubject ? target.view : undefined;
  const page = isSubject ? subjectPage : undefined;
  return {
    status: 200,
    ...(isSubject ? { subject: target.subject } : {}),
    profile: page?.profile ?? 'sha256:zone-story',
    template: page?.template ?? { scope: 'route', key: null },
    document: isSubject ? subjectDocument(view) : homeDocument(id),
    ...(isSubject ? { views: ['overview', 'details'] } : {}),
    reads: isSubject ? (page?.reads ?? {}) : {},
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
  if (!('route' in target) && target.subject !== subjectId) return problem(404, { 'cache-control': 'no-store' });
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
  if (!isRecord(target) || target.subject !== subjectId) return undefined;
  const view = target.view;
  if (view !== undefined && view !== 'overview' && view !== 'details') return undefined;
  return {
    ...subjectPage,
    status: 200,
    subject: subjectId,
    views: ['overview', 'details'],
    ...(view === 'details' ? { document: subjectDocument('details') } : {}),
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
