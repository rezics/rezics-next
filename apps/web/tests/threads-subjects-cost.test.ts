import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { readThreadSubjects, subjectTitle, THREAD_SUBJECT_LIMIT } from '../src/threads/subjects.ts';

const sizes = [0, 1, 4, 20, 128];
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;

function subjectRead(subjectId: string, cover: unknown) {
  return {
    subject: {
      id: subjectId,
      type: 'schema:Book',
      revision: 1,
      release: `sha256:${'b'.repeat(64)}`,
      context: id(9),
      resolution: {},
      labels: { en: `Subject ${subjectId.slice(-3)}`, ja: `主題 ${subjectId.slice(-3)}` },
      descriptions: {},
      aliases: {},
      statements: {},
    },
    related: {},
    summary: {
      id: subjectId,
      type: 'schema:Book',
      types: ['schema:Book'],
      label: { value: `Summary ${subjectId.slice(-3)}`, language: 'en' },
      creativeWork: true,
      cover,
    },
  };
}

function recordingClient(missing: ReadonlySet<string> = new Set()) {
  const calls: { method: string; path: string }[] = [];
  let inFlight = 0;
  let peak = 0;
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push({ method: request.method, path: url.pathname });
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      inFlight -= 1;
      const subject = /^\/v1\/subjects\/([^/]+)$/.exec(url.pathname)?.[1];
      if (!subject || missing.has(subject)) return new Response(null, { status: 404 });
      return Response.json(subjectRead(subject, null));
    },
  });
  return { client, calls, peak: () => peak };
}

test('a thread page reads at most four of its subjects, together, whatever the number attached', async () => {
  for (const size of sizes) {
    const ids = Array.from({ length: size }, (_, index) => id(100 + index));
    const recorded = recordingClient();
    const subjects = await readThreadSubjects(recorded.client, ids);
    const expected = Math.min(size, THREAD_SUBJECT_LIMIT);
    expect(subjects.map((subject) => subject.id)).toEqual(ids.slice(0, expected));
    expect(recorded.calls).toHaveLength(expected);
    expect(recorded.calls.every((call) => call.method === 'GET' && call.path.startsWith('/v1/subjects/'))).toBe(true);
    expect(recorded.peak()).toBe(expected);
  }
});

test('a subject that cannot be read is left out and the others stay', async () => {
  const ids = [id(100), id(101), id(102)];
  const recorded = recordingClient(new Set([ids[1]!]));
  const subjects = await readThreadSubjects(recorded.client, ids);
  expect(subjects.map((subject) => subject.id)).toEqual([ids[0]!, ids[2]!]);
});

test('a title follows the page language, then the kernel label, then English', () => {
  const subject = { label: 'Kernel label', labels: { en: 'English', ja: '日本語' } };
  expect(subjectTitle(subject, 'ja')).toBe('日本語');
  expect(subjectTitle(subject, 'de')).toBe('Kernel label');
  expect(subjectTitle({ label: null, labels: { en: 'English', ja: '日本語' } }, 'de')).toBe('English');
  expect(subjectTitle({ label: null, labels: { ja: '日本語' } }, 'de')).toBe('日本語');
  expect(subjectTitle({ label: null, labels: {} }, 'en')).toBeNull();
});
