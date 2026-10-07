import { describe, expect, test } from 'bun:test';
import { workHref } from '../../work-page/route.ts';
import { collectCopies, loanLabels } from './identity.ts';
import type { CopyRecord, LoanRecord } from './types.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000aa';
const release = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000bb';
const copyId = 'https://rezics.com/id/00000000-0000-4000-8000-000000000015';

function copy(id: string, fields: Partial<CopyRecord> = {}): CopyRecord {
  return { id, work, release, format: 'Paperback', acquiredFrom: null, acquiredAt: null, ownedFrom: null,
    ownedThrough: null, removed: false, version: 1, changedAt: '2026-09-01T00:00:00.000Z', ...fields };
}

function loan(id: string): LoanRecord {
  return { id: 'https://rezics.com/id/00000000-0000-4000-8000-0000000000d1', copy: id, direction: 'lent',
    counterparty: { kind: 'name', name: 'City Library' }, startedAt: '2026-09-01T00:00:00.000Z',
    dueAt: '2026-10-01T12:00:00.000Z', returnedAt: null, version: 1, changedAt: '2026-09-01T00:00:00.000Z',
    state: 'overdue' };
}

describe('copy identity', () => {
  test('names a copy from its own work and release, including one past the first page', async () => {
    const pages = [
      { copies: Array.from({ length: 20 }, (_, index) => copy(`https://rezics.com/id/00000000-0000-4000-8000-0000000000${index.toString(16).padStart(2, '0')}`)),
        nextCursor: 'page-2' },
      { copies: [copy(copyId)], nextCursor: null },
    ];
    let calls = 0;
    const found = await collectCopies(new Set([copyId]), async () => pages[calls++] ?? null);
    expect(calls).toBe(2);
    const labels = await loanLabels([loan(copyId)], {
      copy: async id => found.get(id) ?? null,
      work: async id => {
        expect(id).toBe(work);
        return { id, href: workHref(id), title: 'The Borrowed Atlas' };
      },
      release: async (workId, releaseId) => {
        expect(workId).toBe(work);
        expect(releaseId).toBe(release);
        return { id: releaseId, title: 'The Borrowed Atlas', editionStatement: 'Paperback library edition',
          publicationYear: 1818, isbn13: null };
      },
    });
    const label = labels.get(copyId);
    expect(label?.work).toEqual({ id: work, href: workHref(work), title: 'The Borrowed Atlas' });
    expect(label?.edition).toBe('The Borrowed Atlas — Paperback library edition · 1818');
    expect(label?.format).toBe('Paperback');
  });

  test('uses the release title when the Work itself cannot be read', async () => {
    const labels = await loanLabels([loan(copyId)], {
      copy: async () => copy(copyId),
      work: async () => null,
      release: async () => ({ id: release, title: 'Atlas paperback', editionStatement: null, publicationYear: null,
        isbn13: null }),
    });
    expect(labels.get(copyId)?.work?.title).toBe('Atlas paperback');
    expect(labels.get(copyId)?.work?.id).toBe(work);
  });
});
