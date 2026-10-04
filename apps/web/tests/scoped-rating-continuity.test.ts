import { expect, test } from 'bun:test';
import { continuityFrame, continuityParam, offContinuity, parseContinuity, sameContinuity, withContinuity, type ContinuityChoice }
  from '../features/wiki/continuity.ts';
import { parsePosition, withPosition } from '../features/wiki/position.ts';

const canon = '0199a2b4-1c3e-7a21-8b4d-5e6f7a8b9c0d';
const legends = '0199a2b4-1c3e-7a21-8b4d-5e6f7a8b9c0e';

test('the continuity switch is off unless the address or the host says otherwise', () => {
  expect(parseContinuity({})).toEqual(offContinuity);
  expect(parseContinuity({ continuity: canon })).toEqual({ kind: 'at', continuity: canon });
  expect(parseContinuity({}, { kind: 'at', continuity: canon })).toEqual({ kind: 'at', continuity: canon });
});

test('an address choice outranks the host default, and `off` turns the default off', () => {
  const host: ContinuityChoice = { kind: 'at', continuity: canon };
  expect(parseContinuity({ continuity: legends }, host)).toEqual({ kind: 'at', continuity: legends });
  expect(parseContinuity({ continuity: 'off' }, host)).toEqual(offContinuity);
});

test('a damaged or repeated choice reads as the default, never as another continuity', () => {
  expect(parseContinuity({ continuity: 'canon' })).toEqual(offContinuity);
  expect(parseContinuity({ continuity: [canon, legends] })).toEqual(offContinuity);
  expect(parseContinuity({ continuity: 'nonsense' }, { kind: 'at', continuity: canon })).toEqual({ kind: 'at', continuity: canon });
});

test('Main reads are filtered by the continuity as their frame, and unfiltered when off', () => {
  expect(continuityFrame(offContinuity)).toEqual([]);
  expect(continuityFrame({ kind: 'at', continuity: canon })).toEqual([`https://rezics.com/id/${canon}`]);
});

test('the address carries nothing where the choice is the default', () => {
  const host: ContinuityChoice = { kind: 'at', continuity: canon };
  expect(continuityParam(offContinuity)).toBeUndefined();
  expect(continuityParam(host, host)).toBeUndefined();
  expect(continuityParam(offContinuity, host)).toBe('off');
  expect(continuityParam({ kind: 'at', continuity: legends }, host)).toBe(legends);
  expect(sameContinuity(host, { kind: 'at', continuity: canon })).toBe(true);
});

test('the choice survives every link built from the address, with the reading position, and drops a cursor from another continuity', () => {
  const here = '/en/z/wiki/characters?position=all&cursor=abc#top';
  const chosen = withContinuity(here, { kind: 'at', continuity: canon });
  expect(chosen).toBe(`/en/z/wiki/characters?position=all&continuity=${canon}#top`);
  // Moving the reading position keeps the continuity, and the other way round.
  const moved = withPosition(chosen, { kind: 'at', occurrence: '0199a2b4-1c3e-7a21-8b4d-5e6f7a8b9c0f' });
  expect(moved).toContain(`continuity=${canon}`);
  expect(parsePosition({ position: '0199a2b4-1c3e-7a21-8b4d-5e6f7a8b9c0f' })).toEqual({ kind: 'at', occurrence: '0199a2b4-1c3e-7a21-8b4d-5e6f7a8b9c0f' });
  expect(withContinuity(moved, offContinuity)).not.toContain('continuity=');
  expect(withContinuity(moved, offContinuity)).toContain('position=0199a2b4');
  expect(withContinuity('/en/z/wiki', offContinuity, { kind: 'at', continuity: canon })).toBe('/en/z/wiki?continuity=off');
});
