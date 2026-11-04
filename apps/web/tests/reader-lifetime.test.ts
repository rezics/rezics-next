import { expect, test } from 'bun:test';
import { addressLease, readLease, operationLease } from '../src/reader/lease';

test('read, address and operation admission remain independent and retired addresses never revive', () => {
  let addressCurrent = true;
  let allowed = true;
  let credential: string | null = null;
  const address = addressLease(() => addressCurrent);
  const read = readLease('A', address, () => allowed);
  const command = operationLease(read, 'copy.update', () => allowed, () => credential);
  expect(read.current()).toBe(true);
  expect(command.credential()).toBeNull();
  credential = 'replacement';
  expect(command.credential()).toBe('replacement');
  allowed = false;
  expect(command.current()).toBe(false);
  allowed = true;
  addressCurrent = false;
  expect(read.current()).toBe(false);
  addressCurrent = true;
  expect(read.current()).toBe(false);
  expect(command.credential()).toBeNull();
});
