import { expect, test } from 'bun:test';
import { copiesAddress } from '../src/library/copies-query';
import {
  admitCopiesWindowRead,
  createCopiesWindows,
  reconcileCopiesWindows,
  stageCopiesWindowMove,
} from '../src/library/copies-windows/model';

const page = {
  signedIn: true,
  subjectId: null,
  copies: [],
  next: null,
  addKey: '00000000-0000-4000-8000-000000000001',
};

test('window history retains only its eight most recent admitted cursor predecessors', () => {
  let address = copiesAddress({}, 'en'),
    reader = 'reader-0';
  let state = admitCopiesWindowRead(createCopiesWindows(address, reader, 1), address, reader, 1, page).state;
  for (let index = 1; index <= 10; index++) {
    const cursor = `c${index}`,
      destination = copiesAddress({ cursor }, 'en'),
      nextReader = `reader-${index}`;
    state = stageCopiesWindowMove(state, address, 'more', cursor, false);
    state = reconcileCopiesWindows(state, destination, nextReader, 1, true);
    state = admitCopiesWindowRead(state, destination, nextReader, 1, page).state;
    address = destination;
  }
  expect(state.predecessors).toEqual(['c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
});
