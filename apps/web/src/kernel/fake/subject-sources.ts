import subjectPageRecording from '../recorded/subject-page.json';
import subjectRecording from '../recorded/subject.json';
import type { KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';

const matchUrl = 'https://archive.example.test/little-prince';

const sourceRecords = [
  {
    name: 'Open Library Catalogue',
    url: 'https://openlibrary.org/works/OL45883W',
    licence: { id: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
    attribution: 'Open Library contributors',
  },
  {
    name: 'Library of Congress Catalogue',
    url: 'https://id.loc.gov/authorities/names/n79095566',
    licence: { id: 'ODbL-1.0' },
  },
  {
    name: 'Exhibition notes',
    url: 'https://museum.example.test/exhibitions/prince',
    attribution: 'The Museum Research Team',
  },
  { name: 'Publisher bibliography', url: 'https://publisher.example.test/books/prince' },
  { name: 'Matching statement reference', url: matchUrl },
  {
    name: 'A Long Catalogue Name That Wraps Across Several Lines on a Narrow Phone Screen',
    url: 'https://catalogue.example.test/records/little-prince',
    attribution:
      'Catalogue editors, volunteer proofreaders, translators, and local librarians who checked this record against the original publication in several editions.',
  },
];

type StoryContext = { url?: string };
function selectedSourceRecords(): unknown[] {
  const story = (globalThis as typeof globalThis & { __rezicsStoryContext?: StoryContext }).__rezicsStoryContext;
  const fixture = new URL(story?.url ?? '/', 'https://rezics.local').searchParams.get('sourceRecords');
  return fixture === 'all' ? sourceRecords : [];
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const input: unknown = await request
    .clone()
    .json()
    .catch(() => undefined);
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function subjectPage(): KernelRecording {
  const page = structuredClone(subjectPageRecording) as unknown as KernelRecording & {
    reads: Record<string, { status: number; body: Record<string, unknown> }>;
  };
  const subjectRead = Object.values(page.reads).find((read) => {
    const subject = read.body.subject;
    return typeof subject === 'object' && subject !== null && !Array.isArray(subject);
  });
  if (!subjectRead) throw new Error('The subject page recording has no subject read.');

  const currentRead = structuredClone(subjectRecording) as unknown as {
    subject: Record<string, unknown>;
    related: Record<string, unknown>;
    summary: unknown;
  };
  currentRead.subject.sourceRecords = selectedSourceRecords();
  const statements = currentRead.subject.statements as Record<string, Record<string, unknown>[]>;
  const keyword = statements['schema:keywords']?.[0];
  if (keyword && selectedSourceRecords().length) {
    keyword.references = [
      {
        parts: [
          {
            property: { id: 'schema:url', data_type: 'url' },
            value: { type: 'value', content: matchUrl },
          },
        ],
      },
    ];
  }
  subjectRead.body = {
    ...subjectRead.body,
    subject: currentRead.subject,
    related: currentRead.related,
    summary: currentRead.summary,
  };
  return page;
}

export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: '/v1/pages:read',
    story: async ({ request }) => {
      const input = await body(request);
      const target = input.target;
      if (typeof target !== 'object' || target === null || Array.isArray(target)) return;
      const readTarget = target as Record<string, unknown>;
      if (readTarget.subject !== subjectPageRecording.subject) return;
      if (readTarget.view !== undefined && readTarget.view !== 'overview') return;
      return subjectPage();
    },
  },
];
