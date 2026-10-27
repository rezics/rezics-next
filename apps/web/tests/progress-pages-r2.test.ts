import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProgressRow } from '@rezics/ui/progress-row';
import { ContinueRow } from '../src/library/continue.tsx';
import { readProgress } from '../src/library/continue-read.ts';
import { createRecordedKernelFetch } from '../src/kernel/fake.ts';
import sessionsRecording from '../src/kernel/recorded/library-progress-sessions.json';

const source = async (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const shared = (input: Record<string, unknown>) => input as never;

test('one shared progress formatter uses the localized unit forms and shares', async () => {
  const { progressView } = await import('../src/library/progress-label.ts');
  const amount = (unit: string, value: string, total: string | null = null) =>
    shared({
      mode: 'scalar_amount',
      unit,
      amount: value,
      total,
      completedUnitCount: 0,
      locator: null,
    });

  expect(progressView(amount('chapter', '5'), 'en')).toEqual({ text: 'Ch 5', percent: null });
  expect(progressView(amount('page', '118'), 'en')).toEqual({ text: 'p. 118', percent: null });
  expect(progressView(amount('episode', '3', '12'), 'en')).toEqual({ text: 'Ep 3/12', percent: 25 });
  expect(progressView(amount('percent', '64'), 'en')).toEqual({ text: '64%', percent: 64 });
  expect(progressView(amount('chapter', '5'), 'zh-Hans')?.text).toBe('第5章');
  expect(progressView(amount('episode', '3', '12'), 'zh-Hans')?.text).toBe('3/12 集');
  expect(progressView(amount('page', '118'), 'zh-Hans')?.text).toBe('第118页');
  const chinese = [
    progressView(amount('chapter', '5'), 'zh-Hans')?.text,
    progressView(amount('episode', '3', '12'), 'zh-Hans')?.text,
    progressView(amount('page', '118'), 'zh-Hans')?.text,
  ].join(' ');
  expect(chinese).not.toMatch(/\b(?:Ch|Ep|p\.)\b/i);

  for (const name of ['progress-page.tsx', 'progress-session.tsx', 'continue.tsx']) {
    const text = await source(`../src/library/${name}`);
    expect(text, name).toContain('progress-label');
    expect(text, name).not.toContain('progressValue');
  }
});

test('cursor positions use their locator as the row label on the pages and Continue card', async () => {
  const { progressView } = await import('../src/library/progress-label.ts');
  const cursor = shared({
    mode: 'cursor_position',
    unit: 'chapter',
    amount: null,
    total: null,
    completedUnitCount: 0,
    locator: 'Part 2, chapter 14',
  });
  expect(progressView(cursor, 'en')).toEqual({ text: 'Part 2, chapter 14', percent: null });
  expect(progressView({ ...cursor, locator: null }, 'en')).toEqual({ text: 'In progress', percent: null });

  const recorded = sessionsRecording.progressSessions;
  const client = {
    progressSessions: { get: async () => ({ data: { progressSessions: recorded, next: null } }) },
  } as never;
  const read = await readProgress(client, recorded[0]!.subjectId, 'Bearer story');
  expect(read?.locator).toBe('Part 2, chapter 14');

  const index = await source('../src/library/progress-page.tsx');
  const session = await source('../src/library/progress-session.tsx');
  const home = await source('../src/library/continue.tsx');
  const reader = await source('../src/library/continue-read.ts');
  for (const [name, text] of [
    ['progress index', index],
    ['session page', session],
    ['Continue card', home],
  ]) {
    expect(text, name).toContain('progressView(');
    expect(text, name).toContain('progress?.text');
  }
  expect(reader).toContain('locator: session.locator');
});

test('a known share and its label share one row, while an unknown share has no empty bar', () => {
  const known = renderToStaticMarkup(createElement(ProgressRow, { value: 0.64, label: '64%' }));
  expect(known).toContain('role="progressbar"');
  expect(known).toContain('aria-label="64%"');
  expect(known).toContain('>64%</span>');
  expect(known.indexOf('role="progressbar"')).toBeLessThan(known.indexOf('>64%</span>'));

  const unknown = renderToStaticMarkup(createElement(ProgressRow, { value: null, label: 'p. 118' }));
  expect(unknown).not.toContain('role="progressbar"');
  expect(unknown).toContain('>p. 118</span>');
});

test('the signed-in home story renders one Continue card for every recorded active session up to the row limit', async () => {
  const continueEntries = (await Bun.file(
    new URL('../src/kernel/recorded/library-continue-entries.json', import.meta.url),
  ).json()) as { libraryEntries: { subjectId: string; subject: { label: string; [key: string]: unknown } }[] };
  const recorded = sessionsRecording.progressSessions;
  const fetchRecorded = createRecordedKernelFetch({
    'library-entries': continueEntries as never,
    'library-continue-entries': continueEntries as never,
    'library-progress-sessions': sessionsRecording as never,
  });
  const response = await fetchRecorded('https://api.rezics.test/v1/libraryEntries?state=in_progress&limit=6');
  const active = (await response.json()) as typeof continueEntries;
  expect(active.libraryEntries).toHaveLength(recorded.length);

  const client = {
    progressSessions: {
      get: async ({ query }: { query: { subjectId: string } }) => {
        const item = recorded.filter((session) => session.subjectId === query.subjectId);
        return { data: { progressSessions: item, next: null } };
      },
    },
  } as never;
  const entries = await Promise.all(
    active.libraryEntries.map(async (item) => ({
      subjectId: item.subjectId,
      label: item.subject.label,
      summary: { ...item.subject, id: item.subjectId, label: item.subject.label } as never,
      progress: await readProgress(client, item.subjectId, 'Bearer story'),
    })),
  );
  expect(entries.every((entry) => entry.progress !== null)).toBe(true);
  expect(new Set(entries.map((entry) => entry.progress!.sessionId)).size).toBe(recorded.length);

  const html = renderToStaticMarkup(createElement(ContinueRow, { entries, locale: 'en' }));
  expect((html.match(/data-slot="cover-card"/g) ?? []).length).toBe(recorded.length * 2);
  for (const label of ['Part 2, chapter 14', 'Ep 3/12', 'p. 118', '64%', 'Ch 5']) expect(html).toContain(label);
  expect(html).toContain('role="progressbar"');

  const cards = [...html.matchAll(/<article\b[^>]*data-slot="cover-card"[^>]*>[\s\S]*?<\/article>/g)].map(
    ([card]) => card!,
  );
  const pageCards = cards.filter((card) => card.includes('I Am a Cat'));
  expect(pageCards).toHaveLength(2);
  for (const card of pageCards) {
    expect(card).toContain('p. 118');
    expect(card).not.toContain('role="progressbar"');
  }
});

test('progress page state, completed-unit empty state, and published logs keep the agreed compact structure', async () => {
  const index = await source('../src/library/progress-page.tsx');
  const session = await source('../src/library/progress-session.tsx');
  const logs = await source('../src/library/logs-progress.tsx');

  expect(index).toContain('{stateLabel(session.state)}');
  expect(index).not.toMatch(/stateLabel\(session\.state\)[\s\S]{0,40}unitLabel\(session\.unit\)/);
  expect(session).toContain('stateLabel(session.state)');
  expect(session).not.toContain('modeLabel(session.mode)');
  expect(session).not.toContain('unitLabel(session.unit)');
  expect(index).toContain('modeChoices.map');
  expect(session).toContain('m.library_progress_units_empty()');
  expect(session).not.toContain('m.library_progress_empty()');

  const published = logs.slice(logs.indexOf('function PublishedLogs'), logs.indexOf('export function ProgressLogs'));
  expect(published).toContain('<RelativeTime value={log.publishedAt} />');
  expect(published).toContain('log.account.displayName');
  expect(published).toContain('log.account.handle');
  expect(published).toContain('log.note');
  expect(published).toContain('m.library_logs_open()');
  expect(published).not.toContain('SubjectIdentity');
  expect(published).not.toContain('stateLabel(log.sessionState)');

  for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'es', 'fr']) {
    const messages = (await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json()) as Record<
      string,
      string
    >;
    expect(messages.library_progress_units_empty, locale).toBeTruthy();
  }
});
