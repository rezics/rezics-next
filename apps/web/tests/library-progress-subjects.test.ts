import { expect, test } from 'bun:test';
import { progressIndexSubjects, progressSubjects } from '../src/library/progress-subjects';
import type { PublishedLogPage } from '../src/library/logs-read';
import type { ProgressSessionCore, ProgressSessionPage } from '../src/library/progress-reads';
import type { LibrarySubject } from '../src/library/reads';

const book: LibrarySubject = {
  id: 'book',
  type: 'book',
  types: ['schema:Book'],
  label: 'Night watch',
  typeLabel: 'Book',
  cover: {
    media: 'cover',
    width: 640,
    height: 960,
    placeholder: { thumbhash: '', color: '#547080' },
    variants: [{ format: 'webp', width: 640 }],
    focalPoint: null,
    credit: null,
  },
};

// Only the reference fields are relevant to summary resolution.
const session = (subject: LibrarySubject | null) =>
  ({ subjectId: book.id, versionSubjectId: null, subject, versionSubject: null }) as ProgressSessionCore;
const page = (subject: LibrarySubject | null): ProgressSessionPage => ({
  signedIn: true,
  idempotencyKey: 'key',
  session: { ...session(subject), changes: [], changesNext: null, units: [], unitsNext: null },
});
const logs = (subject: LibrarySubject): PublishedLogPage => ({
  signedIn: true,
  next: null,
  logs: [
    {
      id: 'log',
      subject,
      account: null,
      sessionState: 'active',
      startedAt: '',
      completedAt: null,
      publishedAt: '',
      note: null,
    },
  ],
});

test('a missing session summary reuses the matching log summary by subject id', () => {
  const resolved = progressSubjects(page(null), logs(book));
  expect(resolved.progress.signedIn && resolved.progress.session.subject).toEqual(book);
  expect(resolved.logs.logs[0]?.subject?.cover).toEqual(book.cover);
  const unrelated = progressSubjects(page(null), logs({ ...book, id: 'another-book' }));
  expect(unrelated.progress.signedIn && unrelated.progress.session.subject).toBeNull();
});

test('the session cover wins when another read carries a different cover for that subject', () => {
  const resolved = progressSubjects(page(book), logs({ ...book, cover: { ...book.cover!, media: 'older-cover' } }));
  expect(resolved.logs.logs[0]?.subject?.cover).toEqual(book.cover);
});

test('index rows reuse matching summaries even when those summaries have no image', () => {
  const placeholder = { ...book, cover: null };
  expect(progressIndexSubjects([session(null), session(placeholder)])[0]?.subject).toEqual(placeholder);
  expect(progressIndexSubjects([session(null), session(placeholder), session(book)])[0]?.subject).toEqual(book);
});
