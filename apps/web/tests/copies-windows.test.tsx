import { expect, test } from 'bun:test';
import type { CopiesPageData } from '../src/library/copies-read';
import { copiesAddress } from '../src/library/copies-query';
import {
  admitCopiesWindowRead,
  createCopiesWindows,
  reconcileCopiesWindows,
  stageCopiesWindowMove,
} from '../src/library/copies-windows/model';

const page = (cursor?: string | null, next?: string | null, extra: Partial<CopiesPageData> = {}): CopiesPageData => ({
  signedIn: true,
  subjectId: null,
  ...(cursor === undefined ? {} : { requestedCursor: cursor }),
  copies: [],
  next: next ?? null,
  addKey: '00000000-0000-4000-8000-000000000001',
  ...extra,
});

test('window history keeps eight admitted opaque predecessors and never infers a direct cursor predecessor', () => {
  let address = copiesAddress({}, 'en');
  let reader = 'reader-0';
  let state = createCopiesWindows(address, reader, 1);
  state = admitCopiesWindowRead(state, address, reader, 1, page(null, 'c1')).state;

  for (let index = 1; index <= 10; index++) {
    const cursor = `c${index}`;
    state = stageCopiesWindowMove(state, address, 'more', cursor, false);
    expect(state.pending?.target).toBe(cursor);
    const nextAddress = copiesAddress({ cursor }, 'en');
    reader = `reader-${index}`;
    state = reconcileCopiesWindows(state, nextAddress, reader, 1, true);
    expect(state.pending?.destinationReader).toBe(reader);
    state = admitCopiesWindowRead(state, nextAddress, reader, 1, page(cursor, index === 10 ? null : `c${index + 1}`)).state;
    expect(state.current).toBe(cursor);
    address = nextAddress;
  }

  expect(state.predecessors).toEqual(['c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);

  const direct = copiesAddress({ cursor: 'c10' }, 'en');
  const directState = admitCopiesWindowRead(
    createCopiesWindows(direct, 'direct', 1),
    direct,
    'direct',
    1,
    page('c10'),
  ).state;
  expect(directState.predecessors).toEqual([]);
});

test('failed movement keeps its exact staged destination and cursor restart admits a fresh first-page path', () => {
  const first = copiesAddress({}, 'en');
  let state = createCopiesWindows(first, 'first-reader', 1);
  state = admitCopiesWindowRead(state, first, 'first-reader', 1, page(null, 'opaque-next')).state;
  state = stageCopiesWindowMove(state, first, 'more', 'opaque-next', false);

  const failedAddress = copiesAddress({ cursor: 'opaque-next' }, 'en');
  const failedReader = 'failed-reader';
  state = reconcileCopiesWindows(state, failedAddress, failedReader, 1, true);
  expect(state.pending).toMatchObject({ target: 'opaque-next', destinationReader: failedReader });

  const restarted = admitCopiesWindowRead(state, failedAddress, failedReader, 1, page('opaque-next', 'new-next', {
    cursorRestarted: true,
  })).state;
  expect(restarted).toMatchObject({ current: null, routeCursor: 'opaque-next', predecessors: [], pending: null });
});
