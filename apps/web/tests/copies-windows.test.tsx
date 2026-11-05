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

function admit(
  state: ReturnType<typeof createCopiesWindows>,
  address: ReturnType<typeof copiesAddress>,
  reader: string,
  inventory = page,
) {
  return admitCopiesWindowRead(state, address, reader, 1, inventory).state;
}

test('window history retains only its eight most recent admitted cursor predecessors', () => {
  let address = copiesAddress({}, 'en'),
    reader = 'reader-0';
  let state = admit(createCopiesWindows(address, reader, 1), address, reader);
  for (let index = 1; index <= 10; index++) {
    const cursor = `c${index}`,
      destination = copiesAddress({ cursor }, 'en'),
      nextReader = `reader-${index}`;
    state = stageCopiesWindowMove(state, address, 'more', cursor, false);
    state = reconcileCopiesWindows(state, destination, nextReader, 1, true);
    state = admit(state, destination, nextReader);
    address = destination;
  }
  expect(state.predecessors).toEqual(['c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
});

test('Previous, First and exact Retry traverse three windows without consuming failed destinations', () => {
  const first = copiesAddress({}, 'en');
  let state = admit(createCopiesWindows(first, 'r0', 1), first, 'r0');
  const second = copiesAddress({ cursor: 'c1' }, 'en');
  state = stageCopiesWindowMove(state, first, 'more', 'c1', false);
  state = reconcileCopiesWindows(state, second, 'r1', 1, true);
  state = admit(state, second, 'r1');
  const third = copiesAddress({ cursor: 'c2' }, 'en');
  state = stageCopiesWindowMove(state, second, 'more', 'c2', false);
  state = reconcileCopiesWindows(state, third, 'r2', 1, true);
  expect(state.pending?.target).toBe('c2');
  const failed = admit(state, third, 'r2', { ...page, inventoryState: 'unavailable' });
  expect(failed.predecessors).toEqual([null]);
  expect(failed.pending?.target).toBe('c2');
  expect(stageCopiesWindowMove(failed, third, 'previous', 'c1', false).pending?.target).toBe('c2');
  state = admit(failed, third, 'r2');
  expect(state.current).toBe('c2');
  expect(state.pending).toBeNull();
  expect(state.predecessors).toEqual([null, 'c1']);
  state = stageCopiesWindowMove(state, third, 'previous', 'c1', false);
  state = reconcileCopiesWindows(state, second, 'r3', 1, true);
  state = admit(state, second, 'r3');
  expect(state.current).toBe('c1');
  expect(state.predecessors).toEqual([null]);
  state = stageCopiesWindowMove(state, second, 'first', null, false);
  state = reconcileCopiesWindows(state, first, 'r4', 1, true);
  state = admit(state, first, 'r4');
  expect(state.current).toBeNull();
  expect(state.predecessors).toEqual([]);
});
