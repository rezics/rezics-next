import { expect, mock, test } from 'bun:test';
import { Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyStatusChange, type CopiesPageData, type CopyItem } from '../src/library/copies-read';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';

const readCopyDetail = mock(() => {});
mock.module('../src/library/copies-actions', () => ({
  createCopy() {},
  updateCopy() {},
  deleteCopy() {},
  readCopySubject() {},
  readCopyDetail,
  undoCopy() {},
}));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'x-csrf-token': 'csrf' }) }));
mock.module('../src/kernel/exposure', () => ({
  Exposure: ({ children }: { children: ReactNode }) => <Fragment>{children}</Fragment>,
}));
mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  notFound: () => new Error('not found'),
}));
const { CopiesPage, CopyForm } = await import('../src/library/copies-page');

test('many unresolved copies share one explanation while each closed disclosure retains its own evidence and edit guards', () => {
  setLocale('en', { reload: false });
  const known: CopyItem = {
    id: 'known-copy',
    kind: 'accepted-print-id',
    status: 'accepted-shelf-id',
    kindLabel: '紙の本（当時）',
    kindLabelLanguage: 'ja',
    statusLabel: 'Im Regal (damals)',
    statusLabelLanguage: 'de',
    meaning: 'known',
    statusEditing: { state: 'unsupported' },
    revision: 7,
    idempotencyKey: '10203040-5060-4070-8090-102030405060',
    acquiredOn: '2020-02-29',
    disposedOn: null,
    location: 'Study',
    source: 'Bookshop',
    note: 'First copy',
    subject: {
      id: 'visible-edition',
      type: 'book',
      types: ['book'],
      typeLabel: 'Book',
      label: 'A readable edition',
      cover: null,
    },
  };
  const unresolved: CopyItem[] = [
    {
      ...known,
      id: 'unknown-copy',
      kind: 'legacy-unspecified',
      status: 'legacy-status-A',
      kindLabel: undefined,
      statusLabel: undefined,
      meaning: 'unknown',
      statusEditing: { state: 'unavailable' },
    },
    {
      ...known,
      id: 'unavailable-copy',
      kind: 'archived-kind-B',
      status: 'archived-status-B',
      kindLabel: undefined,
      statusLabel: undefined,
      meaning: 'unavailable',
      statusEditing: { state: 'unavailable' },
      subject: null,
    },
    {
      ...known,
      id: 'raw-copy',
      kind: null,
      status: 'raw-status-C',
      kindLabel: undefined,
      statusLabel: undefined,
      meaning: undefined,
      statusEditing: undefined,
    },
  ];
  const page: CopiesPageData = {
    signedIn: true,
    subjectId: null,
    copies: [known, ...unresolved],
    addKey: known.idempotencyKey,
    next: null,
  };
  const html = renderToStaticMarkup(<CopiesPage page={page} />);
  const ordinary = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gu, '');
  expect(ordinary.split(m.library_copy_history_notice())).toHaveLength(2);
  expect(ordinary).not.toContain(m.library_copy_meaning_unknown());
  expect(ordinary).not.toContain(m.library_history_unavailable());
  expect(ordinary).toContain('<span lang="ja">紙の本（当時）</span>');
  expect(ordinary).toContain('<span lang="de">Im Regal (damals)</span>');
  for (const fact of ['A readable edition', 'Feb 29, 2020', 'Study', 'Bookshop', 'First copy']) {
    expect(ordinary).toContain(fact);
  }
  expect(html).not.toContain('Renamed today');
  expect(html).not.toContain('Loaned today');
  expect(html).not.toContain('<select');

  const rows = [...html.matchAll(/<li\b[^>]*data-slot="list-row"[^>]*>([\s\S]*?)<\/li>/gu)].map((row) => row[1]!);
  expect(rows).toHaveLength(4);
  expect(rows[0]).not.toContain('<details');
  for (const [index, copy] of unresolved.entries()) {
    const row = rows[index + 1]!;
    const disclosures = [...row.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/gu)];
    expect(disclosures).toHaveLength(1);
    const [, attributes, evidence] = disclosures[0]!;
    expect(attributes).not.toMatch(/\bopen\b/u);
    expect(evidence).toMatch(new RegExp(`<summary[^>]*>${m.library_copy_history_details()}</summary>`, 'u'));
    expect(evidence).toContain(`<dt>${m.library_copy_kind()}</dt>`);
    expect(evidence).toContain(`<code>${copy.kind ?? 'null'}</code>`);
    expect(evidence).toContain(`<dt>${m.library_copy_status()}</dt>`);
    expect(evidence).toContain(`<code>${copy.status}</code>`);
    expect(evidence).toContain(
      copy.meaning === 'unknown' ? m.library_copy_meaning_unknown() : m.library_history_unavailable(),
    );
    expect(evidence).not.toContain(
      copy.meaning === 'unknown' ? m.library_history_unavailable() : m.library_copy_meaning_unknown(),
    );
    expect(ordinary).not.toContain(copy.status);
    if (copy.kind) expect(ordinary).not.toContain(copy.kind);
    for (const other of unresolved.filter((other) => other !== copy)) {
      expect(row).not.toContain(other.status);
    }
    expect(copyStatusChange(copy, 'loan')).toBeUndefined();
    const editor = renderToStaticMarkup(
      <CopyForm
        copy={copy}
        inline
        subjectId={null}
        profile={{
          kinds: [{ id: 'print', label: 'Renamed today', statuses: [{ id: 'loan', label: 'Loaned today' }] }],
        }}
        addKey={copy.idempotencyKey}
        onClose={() => {}}
        onCreated={() => {}}
        onSaved={() => {}}
        onRemoved={() => {}}
        onKey={() => {}}
      />,
    );
    expect(editor).not.toContain('<select');
    expect(editor).not.toContain('Renamed today');
    expect(editor).not.toContain('Loaned today');
    expect(editor).toContain(m.library_copy_status_unavailable());
  }
  const missingSubject = rows[2]!;
  expect(missingSubject).toContain('data-slot="cover"');
  expect(missingSubject).toContain(`<p class="font-medium break-words">${m.library_subject_unavailable()}</p>`);
  expect(missingSubject).not.toContain('href=');
  expect(missingSubject).not.toContain('visible-edition');
  expect(missingSubject).not.toContain('A readable edition');
  const knownOnly = renderToStaticMarkup(<CopiesPage page={{ ...page, copies: [known] }} />);
  expect(knownOnly).not.toContain(m.library_copy_history_notice());
  expect(knownOnly).not.toContain('<details');
  expect(knownOnly).toContain('<span lang="ja">紙の本（当時）</span>');
  expect(readCopyDetail).not.toHaveBeenCalled();
});
