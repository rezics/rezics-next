import { expect, mock, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('../src/settings/verification-actions', () => ({ searchVerificationSubjects: async () => [] }));
mock.module('../src/session/query', () => ({
  useSession: () => ({ state: 'signed-in', subject: 'alice', csrfToken: 'test-token' }),
}));
const { VerificationSubjectSearch, VerificationSubjectChooserView } =
  await import('../src/settings/verification-subject-chooser');
type Subject = import('../src/settings/verification-subject-chooser').VerificationSubject;
const person: Subject = { id: 'native-person-id', title: 'Avery', type: 'Person' };
const organization: Subject = { id: 'native-organization-id', title: 'Avery Studio', type: 'Organization' };
const settle = () => new Promise((resolve) => setTimeout(resolve, 270));
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('a current term owns its debounced suggestions and stale completions cannot become selectable', async () => {
  const requests: { query: string; signal: AbortSignal; finish: (subjects: Subject[]) => void }[] = [];
  const search = new VerificationSubjectSearch(
    (query, signal) => new Promise((finish) => requests.push({ query, signal, finish })),
  );
  search.setEnabled(true);
  try {
    search.edit('old');
    await settle();
    expect(search.snapshot().phase).toBe('loading');
    search.edit('new');
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(search.snapshot()).toEqual({ query: 'new', phase: 'pending', subjects: [] });
    requests[0]!.finish([person]);
    await flush();
    expect(search.current(person)).toBe(false);
    expect(search.snapshot().phase).toBe('pending');
    await settle();
    expect(requests.map((request) => request.query)).toEqual(['old', 'new']);
    requests[1]!.finish([organization]);
    await flush();
    expect(search.current(organization)).toBe(true);
    search.edit('later');
    expect(search.current(organization)).toBe(false);
    // Keystrokes replace the single debounce timer; no request for "later" is sent.
    search.edit(` ${'x'.repeat(110)}`);
    await settle();
    expect(requests.map((request) => request.query)).toEqual(['old', 'new', 'x'.repeat(99)]);
    expect(search.snapshot().query.length).toBe(100);
    // Selection clears the search before the parent stores the selected native ID.
    search.clear();
    requests[2]!.finish([person]);
    await flush();
    expect(search.snapshot()).toEqual({ query: '', phase: 'idle', subjects: [] });
    expect(search.current(person)).toBe(false);
  } finally {
    search.setEnabled(false);
  }
});

test('failed search stays visibly failed until explicit retry; empty and account loss cannot retain selectable results', async () => {
  let attempts = 0;
  let finish: (subjects: Subject[]) => void = () => {};
  const search = new VerificationSubjectSearch(async () => {
    attempts++;
    if (attempts === 1) throw new Error('native search unavailable');
    if (attempts === 2) return [];
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  search.setEnabled(true);
  try {
    search.edit('Avery');
    await settle();
    expect(search.snapshot()).toEqual({ query: 'Avery', phase: 'failed', subjects: [] });
    await settle();
    expect(attempts).toBe(1);
    search.retry();
    await flush();
    expect(search.snapshot()).toEqual({ query: 'Avery', phase: 'ready', subjects: [] });
    search.edit('Avery Studio');
    await settle();
    search.setEnabled(false);
    finish([organization]);
    await flush();
    expect(search.snapshot()).toEqual({ query: '', phase: 'idle', subjects: [] });
    expect(search.current(organization)).toBe(false);
    search.retry();
    search.edit('another account');
    await settle();
    expect(attempts).toBe(3);
  } finally {
    search.setEnabled(false);
  }
});

test('the chooser exposes a labelled bounded combobox and selected presentation keeps Change separate from form submission', () => {
  const html = renderToStaticMarkup(
    createElement(VerificationSubjectChooserView, { selected: null, onSelect: () => {} }),
  );
  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-autocomplete="list"');
  expect(html).toContain('maxLength="100"');
  expect(html).toContain('aria-describedby=');
  const selected = renderToStaticMarkup(
    createElement(VerificationSubjectChooserView, { selected: person, onSelect: () => {}, disabled: true }),
  );
  expect(selected).toContain('Avery');
  expect(selected).toContain('type="button"');
  expect(selected).toContain('disabled');
  expect(selected).not.toContain('role="combobox"');
});

test('unfinished composition cancels queued and old requests; only the committed current term is debounced', async () => {
  const requests: { query: string; signal: AbortSignal; finish: (subjects: Subject[]) => void }[] = [];
  const search = new VerificationSubjectSearch(
    (query, signal) => new Promise((finish) => requests.push({ query, signal, finish })),
  );
  search.setEnabled(true);
  try {
    search.edit('queued');
    search.startComposition();
    search.edit('あ');
    await settle();
    expect(requests).toHaveLength(0);
    expect(search.snapshot()).toEqual({ query: 'あ', phase: 'idle', subjects: [] });
    search.endComposition('あべ');
    expect(requests).toHaveLength(0);
    await settle();
    expect(requests.map((request) => request.query)).toEqual(['あべ']);
    search.startComposition();
    expect(requests[0]!.signal.aborted).toBe(true);
    requests[0]!.finish([person]);
    await flush();
    expect(search.current(person)).toBe(false);
    search.edit('スタ');
    await settle();
    expect(requests).toHaveLength(1);
    search.endComposition('スタジオ');
    await settle();
    expect(requests.map((request) => request.query)).toEqual(['あべ', 'スタジオ']);
    requests[1]!.finish([organization]);
    await flush();
    expect(search.current(organization)).toBe(true);
    // Exact current-result identity is still required, even for matching IDs.
    expect(search.current({ ...organization })).toBe(false);
    search.startComposition();
    search.setEnabled(false);
    search.endComposition('discarded');
    await settle();
    expect(requests).toHaveLength(2);
    expect(search.snapshot()).toEqual({ query: '', phase: 'idle', subjects: [] });
  } finally {
    search.setEnabled(false);
  }
});

test('the chooser query keeps complete astral characters within its existing input budget', async () => {
  const queries: string[] = [];
  const search = new VerificationSubjectSearch(async (query) => {
    queries.push(query);
    return [];
  });
  search.setEnabled(true);
  try {
    search.edit(`${'a'.repeat(98)}😀extra`);
    expect(search.snapshot().query).toBe(`${'a'.repeat(98)}😀`);
    await settle();
    search.edit(`${'a'.repeat(99)}😀extra`);
    expect(search.snapshot().query).toBe('a'.repeat(99));
    // Native maxlength may already have truncated the input before the controlled edit.
    search.edit(`${'a'.repeat(99)}\uD83D`);
    expect(search.snapshot().query).toBe('a'.repeat(99));
    await settle();
    expect(queries).toEqual([`${'a'.repeat(98)}😀`, 'a'.repeat(99)]);
    expect(queries.every((query) => query.isWellFormed())).toBe(true);
  } finally {
    search.setEnabled(false);
  }
});

test('stalled chooser requests fail without empty results or replay, and explicit retry keeps the term', async () => {
  const schedule = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback, delay, ...args) =>
    schedule(callback, delay === 10_000 ? 0 : delay, ...args)) as typeof setTimeout);
  let calls = 0;
  let signal!: AbortSignal;
  const search = new VerificationSubjectSearch(async (_query, current) => {
    signal = current;
    return ++calls === 1 ? new Promise(() => {}) : [person];
  });
  try {
    search.setEnabled(true);
    search.edit('Avery');
    await settle();
    expect(search.snapshot()).toEqual({ query: 'Avery', phase: 'failed', subjects: [] });
    expect(signal.aborted).toBe(true);
    expect(calls).toBe(1);
    search.retry();
    await settle();
    expect(search.current(person)).toBe(true);
    expect(calls).toBe(2);
  } finally {
    search.setEnabled(false);
    timer.mockRestore();
  }
});
