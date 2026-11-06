import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  collectionTransferDestinationRead,
  collectionTransferMatchedSource,
  collectionTransferReadback,
  collectionTransferReceipt,
  collectionTransferReceiptUpdate,
  type CollectionTransferReview,
} from '../src/library/collection-placement-journey/transfer';
import { CollectionTransferReceiptPanel } from '../src/library/collection-transfer-receipt';
import { CollectionTransferReviewPanel } from '../src/library/collection-transfer-review';
import { m } from '../src/paraglide/messages.js';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';

const review: CollectionTransferReview = {
  destination: { id: 'dest', title: 'Later shelf', revision: 4 },
  after: 'anchor-1',
  anchor: { id: 'anchor-1', title: 'Repeated work', page: 2, position: 3 },
  sourceId: 'source',
  sourceTitle: 'Source shelf',
  sourceRevision: 7,
  sourceHref: '/en/collections/source',
  destinationHref: '/en/collections/dest',
  occurrences: [
    { id: 'occ-1', title: 'First occurrence' },
    { id: 'occ-1-again', title: 'First occurrence' },
  ],
  memberIds: ['occ-1', 'occ-1-again'],
  idempotencyKey: 'key',
};

test('review keeps duplicate occurrence identities and the captured destination revision', () => {
  const previous = getLocale();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const html = renderToStaticMarkup(
        createElement(CollectionTransferReviewPanel, {
          transfer: review,
          transferState: 'review',
          pending: false,
          conflict: false,
          draftFrozen: false,
          canWrite: true,
          canRead: true,
          headingRef: { current: null },
          onConfirm() {},
          onRetryExact() {},
          onReread() {},
          onCancel() {},
        }),
      );
      expect(html).toContain('occ-1-again');
      expect(html).toContain(m.library_collection_move_review_revision({ revision: 4 }));
      expect(html).toContain(m.library_collection_move_anchor_review({ page: 2, position: 3, title: 'Repeated work' }));
      expect(html).toContain(m.library_collection_move_confirm());
    }
  } finally {
    setLocale(previous, { reload: false });
  }
});

test('source and destination readbacks settle independently without inventing a successful order', () => {
  expect(collectionTransferReadback('source', 'dest', { id: 'source' }, { id: 'dest' }, true)).toBe('ready');
  expect(collectionTransferReadback('source', 'dest', { id: 'source' }, { id: 'dest' })).toBe('unavailable');
  expect(collectionTransferReadback('source', 'dest', { id: 'source' }, undefined, true)).toBe('unavailable');
  expect(collectionTransferReadback('source', 'dest', undefined, { id: 'dest' }, true)).toBe('unavailable');
  const receipt = collectionTransferReceipt(review, 8, 5, 'unavailable');
  const previous = getLocale();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const html = renderToStaticMarkup(
        createElement(CollectionTransferReceiptPanel, {
          receipt,
          pending: false,
          headingRef: { current: null },
          onReread() {},
        }),
      );
      expect(html).toContain(m.library_collection_move_receipt_revisions({ source: 8, destination: 5 }));
      expect(html).toContain(m.library_collection_move_source_link({ title: 'Source shelf' }));
      expect(html).toContain(m.library_collection_move_destination_link({ title: 'Later shelf' }));
      expect(html).toContain(m.library_collection_move_read_current());
      expect(html).toContain(m.library_collection_move_receipt_source_unavailable());
      expect(html).toContain(m.library_collection_move_receipt_destination_unavailable());
    }
  } finally {
    setLocale(previous, { reload: false });
  }
});

test('receipt reread keeps a successful side and does not invent ready from one miss', () => {
  const receipt = collectionTransferReceipt(review, 8, 5, 'unavailable');
  expect(collectionTransferReceiptUpdate(receipt, { id: 'source', revision: 9 }, undefined, true)).toEqual({
    ...receipt,
    sourceRevision: 9,
    sourceAdmitted: true,
    destinationAdmitted: false,
    membersAdmitted: false,
    state: 'unavailable',
  });
  expect(collectionTransferReceiptUpdate(receipt, undefined, { id: 'dest', revision: 6 }, true)).toEqual({
    ...receipt,
    destinationRevision: 6,
    sourceAdmitted: false,
    destinationAdmitted: true,
    membersAdmitted: true,
    state: 'unavailable',
  });
  expect(
    collectionTransferReceiptUpdate(receipt, { id: 'source', revision: 9 }, { id: 'dest', revision: 6 }, false),
  ).toEqual({
    ...receipt,
    sourceRevision: 9,
    destinationRevision: 6,
    sourceAdmitted: true,
    destinationAdmitted: true,
    membersAdmitted: false,
    state: 'unavailable',
  });
  expect(
    collectionTransferReceiptUpdate(receipt, { id: 'source', revision: 9 }, { id: 'dest', revision: 6 }, true),
  ).toEqual({
    ...receipt,
    sourceRevision: 9,
    destinationRevision: 6,
    sourceAdmitted: true,
    destinationAdmitted: true,
    membersAdmitted: true,
    state: 'ready',
  });
});

test('confirmation readback requires a ready source page and a matching destination header', async () => {
  expect(collectionTransferMatchedSource('source', { id: 'source', memberState: 'unavailable' })).toBeUndefined();
  expect(collectionTransferMatchedSource('source', { id: 'source', revision: 9 })).toEqual({
    id: 'source',
    revision: 9,
  });
  expect(
    await collectionTransferDestinationRead('dest', Promise.resolve({ id: 'other', revision: 2 }), async () => ({
      members: [],
    })),
  ).toEqual({ destination: undefined, membersAdmitted: false });
  expect(
    await collectionTransferDestinationRead('dest', Promise.resolve({ id: 'dest', revision: 6 }), async () => {
      throw new Error('members unavailable');
    }),
  ).toEqual({ destination: { id: 'dest', revision: 6 }, membersAdmitted: false });
  expect(
    await collectionTransferDestinationRead('dest', Promise.resolve({ id: 'dest', revision: 6 }), async () => ({
      members: [],
    })),
  ).toEqual({ destination: { id: 'dest', revision: 6 }, membersAdmitted: true });
});
