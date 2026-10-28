import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProgressRow } from '@rezics/ui/progress-row';

const source = async (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const shared = (input: Record<string, unknown>) => input as never;
const catalogues = Object.fromEntries(
  await Promise.all(
    ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'es', 'fr'].map(async (locale) => [
      locale,
      (await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json()) as Record<string, string>,
    ]),
  ),
) as Record<string, Record<string, string>>;

mock.module('../src/paraglide/messages.js', () => ({
  m: new Proxy(
    {},
    {
      get(_target, key) {
        return (values: Record<string, string> = {}, options: { locale?: string } = {}) => {
          const message = catalogues[options.locale ?? 'en']?.[String(key)];
          if (!message) throw new Error(`Missing message ${String(key)} for ${options.locale ?? 'en'}`);
          return message.replace(/\{(\w+)\}/g, (_match, name: string) => values[name] ?? '');
        };
      },
    },
  ),
}));

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
  ).json()) as {
    libraryEntries: { subjectId: string; state: string; subject: { label: string; [key: string]: unknown } }[];
  };
  const continueSessions = (await Bun.file(
    new URL('../src/kernel/recorded/library-continue-progress-sessions.json', import.meta.url),
  ).json()) as { progressSessions: Record<string, unknown>[] };
  const active = continueEntries.libraryEntries.filter((entry) => entry.state === 'in_progress');
  const recorded = continueSessions.progressSessions.filter((session) => session.state === 'active');
  expect(active).toHaveLength(recorded.length);
  const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake.ts');
  const storyFetch = createStoryRecordedKernelFetch();
  const entriesResponse = await storyFetch('http://kernel.test/v1/libraryEntries?view=FULL&limit=6&state=in_progress');
  expect(entriesResponse.status).toBe(200);
  const storyEntries = (await entriesResponse.json()) as { libraryEntries: { subjectId: string }[] };
  expect(storyEntries.libraryEntries).toHaveLength(active.length);
  expect(storyEntries.libraryEntries.length).toBeLessThanOrEqual(6);
  const storySessions = await Promise.all(
    storyEntries.libraryEntries.map(async ({ subjectId }) => {
      const response = await storyFetch(`http://kernel.test/v1/progressSessions?subjectId=${subjectId}&limit=5`);
      expect(response.status).toBe(200);
      return (await response.json()) as { progressSessions: Record<string, unknown>[] };
    }),
  );
  expect(storySessions.flatMap(({ progressSessions }) => progressSessions)).toHaveLength(active.length);
  const bySubject = new Map(recorded.map((session) => [session.subjectId, session]));
  const { progressView } = await import('../src/library/progress-label.ts');
  const rows = active.map((entry) => {
    const session = bySubject.get(entry.subjectId);
    expect(session, entry.subject.label).toBeDefined();
    return progressView(shared(session!), 'en')!;
  });
  expect(rows).toHaveLength(active.length);
  for (const label of ['Part 2, chapter 14', 'Ep 3/12', 'p. 118', '64%', 'Ch 5'])
    expect(rows.map((row) => row.text)).toContain(label);
  expect(rows.filter((row) => row.percent !== null).length).toBeGreaterThanOrEqual(2);

  const cards = rows.map((row) =>
    renderToStaticMarkup(
      createElement(ProgressRow, { value: row.percent == null ? null : row.percent / 100, label: row.text }),
    ),
  );
  expect(cards.some((card) => card.includes('role="progressbar"'))).toBe(true);
  const withoutShare = cards.find((card) => card.includes('p. 118'));
  expect(withoutShare).toBeDefined();
  expect(withoutShare).not.toContain('role="progressbar"');

  const continueCard = await source('../src/library/continue.tsx');
  const fake = await source('../src/kernel/fake.ts');
  expect(continueCard).toContain('<CoverCard');
  expect(continueCard).toContain('progress={{');
  expect(continueCard).not.toContain('ProgressRow');
  expect(continueCard).toContain('value: progress?.percent == null ? null : progress.percent / 100');
  expect(continueCard).toContain('label: progress?.text');
  expect(fake).toContain("'library-continue-entries'");
  expect(fake).toContain("'library-continue-progress-sessions'");
});

test('progress page state, completed-unit empty state, and published logs keep the agreed compact structure', async () => {
  const index = await source('../src/library/progress-page.tsx');
  const session = await source('../src/library/progress-session.tsx');
  const sessionHeader = session.slice(session.indexOf('<header'), session.indexOf('</header>'));
  const logs = await source('../src/library/logs-progress.tsx');

  expect(index).toContain('{stateLabel(session.state)}');
  expect(index).not.toMatch(/stateLabel\(session\.state\)[\s\S]{0,40}unitLabel\(session\.unit\)/);
  expect(sessionHeader).toContain('stateLabel(session.state)');
  expect(sessionHeader).not.toContain('modeLabel(session.mode)');
  expect(sessionHeader).not.toContain('unitLabel(session.unit)');
  expect(index).toContain('modeChoices.map');
  expect(session).not.toMatch(/m\.library_progress_mode_(?:amount|cursor|units)\(\)/);
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
    expect(messages.library_progress_changes_empty, locale).toBeTruthy();
    expect(messages.library_progress_units_empty, locale).toBeTruthy();
  }
  expect(catalogues.en.library_progress_units_empty).toBe('No units have been completed yet.');
});
