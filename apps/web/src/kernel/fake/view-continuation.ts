import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import demoFixtures from '../fixtures.json';
import type { SubjectPageData } from '../../features/pages/subject';
import type { Fixtures, KernelRecording } from '../fake';
import type { FakeRoute } from '../fake-modules.ts';

export const continuationSubject = { id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e91', label: 'Continuation example' };
const fixtures = {
  ...demoFixtures,
  subjects: [
    ...demoFixtures.subjects,
    {
      ...demoFixtures.subjects[0],
      id: continuationSubject.id,
      labels: { en: continuationSubject.label, 'zh-Hans': '续页示例' },
    },
  ],
} as unknown as Fixtures;

/** Contract-shaped continuation data; recordings stay unchanged. */
function editions(later: boolean, limit: number) {
  return {
    links: Array.from({ length: later ? Math.min(3, limit) : limit }, (_, index) => ({
      subject: `0192f3a0-6c1e-7b2a-9d4e-${String(index + (later ? 100 : 1)).padStart(12, '0')}`,
      label: `${later ? 'Later' : 'First'} edition ${index + 1}`,
      type: 'schema:Book',
      property: 'schema:exampleOfWork',
      summary: null,
    })),
    count: { value: 30, exact: true },
    next: 'continuation-next',
  };
}

async function demoPage(request: Request): Promise<KernelRecording | undefined> {
  const input = (await request.clone().json()) as { target?: { subject?: unknown } };
  if (input.target?.subject !== continuationSubject.id) return;
  const { pageRead } = await import('../fake');
  const response = await pageRead(fixtures, request);
  const page = (await response.json()) as SubjectPageData;
  if (response.status !== 200) return { status: response.status, __responseBody: page };
  const plan = planReads(platformRegistry, page.document as CompositionDocument, { subject: continuationSubject.id });
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind === 'links' && read.property === 'schema:exampleOfWork')
      page.reads[key] = { status: 200, body: editions(false, read.limit) };
  }
  return { status: 200, ...page };
}

async function demoSubject() {
  const page = await demoPage(
    new Request('https://kernel.invalid/v1/pages:read', {
      method: 'POST',
      body: JSON.stringify({ target: { subject: continuationSubject.id } }),
    }),
  );
  if (!page?.reads) return { status: 404, code: 'not_found' };
  const read = Object.values(page.reads as Record<string, { body: Record<string, unknown> }>).find(
    (read) => read.body.subject,
  );
  return { status: 200, ...read?.body };
}

function continuation({ request, match }: { request: Request; match: RegExpExecArray | null }) {
  const cursor = new URL(request.url).searchParams.get('cursor');
  if (cursor === null) return;
  if (cursor === 'refuse') return { status: 400, problem: { code: 'invalid_cursor' } };
  if (match?.[1] === continuationSubject.id && match[2] === 'links')
    return { status: 200, ...editions(true, Number(new URL(request.url).searchParams.get('limit') ?? 24)) };
  return match?.[2] === 'links'
    ? {
        status: 200,
        links: [{ subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11', label: 'Continuation item' }],
        count: { value: 2, exact: false },
        next: 'continuation-next',
      }
    : {
        status: 200,
        collections: [{ id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e12', title: 'Continuation collection' }],
        count: { value: 2, exact: false },
        next: 'continuation-next',
      };
}

const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: '/v1/pages:read',
    story: ({ request }) => demoPage(request),
    fixture: ({ request }) => demoPage(request),
  },
  { method: 'GET', path: `/v1/subjects/${continuationSubject.id}`, story: demoSubject, fixture: demoSubject },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)\/(links|collections)$/,
    story: continuation,
    fixture: continuation,
  },
];

export { routes };
