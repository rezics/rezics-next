import type { FakeRoute } from '../fake-modules';
import type { KernelClient, SubjectRead } from '@rezics/client';
import demoFixtures from '../fixtures.json';
import type { Fixtures } from '../fake';
import subjectRecording from '../recorded/subject.json';

/** A readable catalogue subject with no activated library profile or linked account. */
export const unprofiledSubjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000803';
const unprofiledType = 'schema:Person';
const labels: Record<string, string> = {
  en: 'Person',
  'zh-Hant': '人物',
  'zh-Hans': '人物',
  ja: '人物',
  ko: '사람',
  de: 'Person',
  fr: 'Personne',
  es: 'Persona',
};
const subject: SubjectRead['subject'] = {
  id: unprofiledSubjectId,
  type: unprofiledType,
  revision: 1,
  release: subjectRecording.subject.release,
  context: subjectRecording.subject.context,
  resolution: {},
  relationCounts: {},
  labels,
  descriptions: {},
  aliases: {},
  statements: {},
  sourceRecords: [],
};

function subjectRead(request: Request): SubjectRead {
  const locale = request.headers.get('accept-language')?.split(',')[0]?.trim() ?? 'en';
  return {
    subject,
    account: null,
    related: {},
    summary: {
      id: unprofiledSubjectId,
      type: unprofiledType,
      types: [unprofiledType],
      label: { value: labels[locale] ?? labels.en!, language: labels[locale] ? locale : 'en' },
      creativeWork: false,
      cover: null,
    },
  };
}

type PageReadResponse = NonNullable<Awaited<ReturnType<KernelClient['pages']['$read']['post']>>['data']>;
type PageReadInput = Parameters<KernelClient['pages']['$read']['post']>[0];

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/accounts',
    story: ({ request }) => {
      // Canonical Person reads look up a verified account even when subject.account is null.
      // Decline other selectors instead of letting this subject inherit the recorded Mira account.
      if (new URL(request.url).searchParams.get('agent') !== unprofiledSubjectId) return;
      return { status: 200, accounts: [], next: null };
    },
  },
  {
    method: 'POST',
    path: '/v1/pages:read',
    story: async ({ request }) => {
      const input: PageReadInput = await request.clone().json();
      if (
        !input ||
        typeof input !== 'object' ||
        !('target' in input) ||
        !input.target ||
        typeof input.target !== 'object' ||
        !('subject' in input.target) ||
        input.target.subject !== unprofiledSubjectId
      )
        return;
      const { pageRead } = await import('../fake');
      const fixtures: Fixtures = {
        subjects: [subject],
        properties: demoFixtures.properties,
        redirects: {},
        types: demoFixtures.types,
        summaries: { [unprofiledSubjectId]: subjectRead(request).summary! },
        accounts: [],
      };
      const response = await pageRead(fixtures, request);
      const value: PageReadResponse = await response.json();
      return { status: response.status, ...value };
    },
  },
  {
    method: 'GET',
    path: '/v1/progressSessions',
    story: ({ request }) => {
      if (new URL(request.url).searchParams.get('subjectId') !== unprofiledSubjectId) return;
      return { status: 200, progressSessions: [], next: null };
    },
  },
  {
    method: 'GET',
    path: '/v1/copies',
    story: ({ request }) => {
      if (new URL(request.url).searchParams.get('subjectId') !== unprofiledSubjectId) return;
      return { status: 200, copies: [], next: null };
    },
  },
  {
    method: 'GET',
    path: `/v1/subjects/${unprofiledSubjectId}`,
    story: ({ request }) => ({ status: 200, ...subjectRead(request) }),
  },
];
