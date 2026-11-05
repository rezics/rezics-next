import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProgressRow } from '@rezics/ui/progress-row';
import definitionsRecording from '../src/kernel/recorded/definitions-release.json';
import { progressSessionProfile } from '../src/library/progress-profile';
import type { ProgressLabelInput } from '../src/library/progress-label';
import type { Release } from '../src/subject/definitions';

const source = async (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const recordedRelease = definitionsRecording.release as unknown as Release;
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
  const amount = (unit: string, value: string, total: string | null = null, locale = 'en'): ProgressLabelInput => ({
    mode: 'scalar_amount',
    unit,
    ...progressSessionProfile(recordedRelease, '', 'scalar_amount', unit, locale),
    amount: value,
    total,
    completedUnitCount: 0,
    locator: null,
  });

  expect(progressView(amount('chapter', '5'), 'en')).toEqual({ text: '5 chapters', percent: null });
  expect(progressView(amount('page', '118'), 'en')).toEqual({ text: '118 pages', percent: null });
  expect(progressView(amount('episode', '3', '12'), 'en')).toEqual({ text: '3 / 12 episodes', percent: 25 });
  expect(progressView(amount('percent', '64'), 'en')).toEqual({ text: '64%', percent: 64 });
  expect(progressView(amount('page', '1'), 'en')).toEqual({ text: '1 page', percent: null });
  expect(progressView(amount('page', '1', '12'), 'en')).toEqual({ text: '1 / 12 pages', percent: (1 / 12) * 100 });
  expect(progressView(amount('page', '118.000001'), 'en')?.text).toBe('118.000001 pages');
  expect(progressView(amount('chapter', '5', null, 'zh-Hans'), 'zh-Hans')?.text).toBe('5章');
  expect(progressView(amount('episode', '3', '12', 'zh-Hans'), 'zh-Hans')?.text).toBe('3/12集');
  expect(progressView(amount('page', '118', null, 'zh-Hans'), 'zh-Hans')?.text).toBe('118页');
  const chinese = [
    progressView(amount('chapter', '5', null, 'zh-Hans'), 'zh-Hans')?.text,
    progressView(amount('episode', '3', '12', 'zh-Hans'), 'zh-Hans')?.text,
    progressView(amount('page', '118', null, 'zh-Hans'), 'zh-Hans')?.text,
  ].join(' ');
  expect(chinese).not.toMatch(/\b(?:Ch|Ep|p\.)\b/i);

  const { parseUnitBatch } = await import('../src/library/progress-reads');
  const sparse = parseUnitBatch('1,3,7');
  expect(sparse).toEqual({ ok: true, ids: ['1', '3', '7'] });
  if (!sparse.ok) throw new Error('Expected the sparse unit IDs');
  expect(
    progressView(
      {
        ...amount('chapter', '3', '12'),
        ...progressSessionProfile(recordedRelease, '', 'completed_units', 'chapter', 'en'),
        mode: 'completed_units',
        amount: null,
        completedUnitCount: sparse.ids.length,
      },
      'en',
    ),
  ).toEqual({ text: '3 / 12 chapters', percent: 25 });

  for (const name of ['progress-page.tsx', 'progress-session.tsx', 'continue.tsx']) {
    const text = await source(`../src/library/${name}`);
    expect(text, name).toContain('progress-label');
    expect(text, name).not.toContain('progressValue');
  }
});

test('cursor labels preserve free text and use exact positions when supplied on pages and Continue', async () => {
  const { progressView } = await import('../src/library/progress-label.ts');
  const cursor: ProgressLabelInput = {
    mode: 'cursor_position',
    unit: 'chapter',
    ...progressSessionProfile(recordedRelease, '', 'cursor_position', 'chapter', 'en'),
    amount: null,
    total: null,
    completedUnitCount: 0,
    locator: 'Part 2, chapter 14',
  };
  expect(progressView(cursor, 'en')).toEqual({ text: 'Part 2, chapter 14', percent: null });
  expect(progressView(cursor, 'zh-Hans')).toEqual({ text: 'Part 2, chapter 14', percent: null });
  expect(progressView({ ...cursor, locator: null }, 'en')).toEqual({ text: 'In progress', percent: null });
  expect(progressView({ ...cursor, position: '42.000001' }, 'en')).toEqual({
    text: '42.000001 chapters',
    percent: null,
  });

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

test('the retained Continue presentation fixture preserves every recorded active session up to the row limit', async () => {
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
  const { recordedContinueSessions } = await import('../src/kernel/fake/library-continue');
  const { continueProgress } = await import('../src/library/continue-read');
  const presented = recordedContinueSessions('en');
  const bySubject = new Map(presented.map((session) => [session.subjectId, session]));
  const { progressView } = await import('../src/library/progress-label.ts');
  const rows = active.map((entry) => {
    const session = bySubject.get(entry.subjectId);
    expect(session, entry.subject.label).toBeDefined();
    const progress = continueProgress(session!);
    expect(progress).toMatchObject({
      sessionId: session!.id,
      mode: session!.mode,
      unit: session!.unit,
      unitLabel: session!.unitLabel,
      unitLabelLanguage: session!.unitLabelLanguage,
      unitCountForms: session!.unitCountForms,
      dimension: session!.dimension,
      amount: session!.amount,
      total: session!.total,
      position: session!.position,
      locator: session!.locator,
      completedUnitCount: session!.completedUnitCount,
    });
    return progressView(progress, 'en')!;
  });
  expect(rows).toHaveLength(active.length);
  for (const label of ['42 chapters', '3 / 12 episodes', '118 pages', '64%', '5 chapters'])
    expect(rows.map((row) => row.text)).toContain(label);
  expect(rows.filter((row) => row.percent !== null).length).toBeGreaterThanOrEqual(2);
  expect(presented.map(({ id }) => id)).toEqual(recorded.map(({ id }) => id));
  expect(presented.find(({ mode }) => mode === 'cursor_position')).toMatchObject({
    locator: 'Part 2, chapter 14',
    position: '42',
    amount: null,
  });
  for (const [locale, pageLabel] of [
    ['en', '118 pages'],
    ['de', '118 Seiten'],
    ['es', '118 páginas'],
    ['fr', '118 pages'],
    ['ja', '118ページ'],
    ['ko', '118쪽'],
    ['zh-Hans', '118页'],
    ['zh-Hant', '118頁'],
  ] as const) {
    const session = recordedContinueSessions(locale).find(({ unit }) => unit === 'page')!;
    const progress = continueProgress(session)!;
    expect(progress.unitLabelLanguage, locale).toBe(locale);
    expect(progress.unitCountForms, locale).toEqual(session.unitCountForms);
    expect(progressView(progress, locale)?.text, locale).toBe(pageLabel);
  }

  const cards = rows.map((row) =>
    renderToStaticMarkup(
      createElement(ProgressRow, { value: row.percent == null ? null : row.percent / 100, label: row.text }),
    ),
  );
  expect(cards.some((card) => card.includes('role="progressbar"'))).toBe(true);
  const withoutShare = cards.find((card) => card.includes('118 pages'));
  expect(withoutShare).toBeDefined();
  expect(withoutShare).not.toContain('role="progressbar"');

  const continueCard = await source('../src/library/continue.tsx');
  const fake = await source('../src/kernel/fake.ts');
  expect(continueCard).toContain('<CoverCard');
  expect(continueCard).toContain('progress: {');
  expect(continueCard).not.toContain('ProgressRow');
  expect(continueCard).toContain('value: progress?.percent == null ? null : progress.percent / 100');
  expect(continueCard).toContain('label: progressLabel');
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
  expect(index).toMatch(
    /choices\s*\?\.map\(\(allowed\) => modeChoices\.find\(\(choice\) => choice\.value === allowed\.mode\)!\)/,
  );
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
