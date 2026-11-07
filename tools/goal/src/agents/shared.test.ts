import { expect, test } from 'bun:test';
import { parseExitObject, textSignals } from './shared.ts';

const blocked = { status: 'blocked', blocker: { kind: 'tool', detail: 'example' } };
const waiting = { status: 'waiting', checks: ['check-1'] };
const success = { status: 'success', summary: 'done', blocker: null, checks: [], approaches: [] };

test('supported wrapped exit objects remain usable', () => {
  expect(parseExitObject(`Earlier: ${JSON.stringify(waiting)}\nReport: ${JSON.stringify(blocked)}`)).toEqual(blocked);
  expect(parseExitObject(JSON.stringify(success))).toEqual(success);
  expect(parseExitObject(`Note:\n${JSON.stringify(success)}\n`)).toEqual(success);
});

test('malformed output cannot combinatorial-parse or fabricate success', () => {
  const soup = '{'.repeat(5000) + JSON.stringify(success) + '}'.repeat(5000);
  const started = performance.now();
  expect(parseExitObject(soup)).toBeNull();
  expect(parseExitObject('{'.repeat(5000) + '}'.repeat(5000))).toBeNull();
  expect(parseExitObject('{"outer":{"status":"success"}} trailing')).toBeNull();
  expect(parseExitObject('{"status":"error"}')).toBeNull();
  expect(performance.now() - started).toBeLessThan(250);
});

test('a complete report after a truncated object is still the exit', () => {
  const truncated = `{"status":"waiting","checks":["earlier"],"summary":"cut off here`;
  const final = { status: 'waiting', checks: ['1d206ad1'] };
  expect(parseExitObject(`${truncated}\nReport: ${JSON.stringify(final)}`)).toEqual(final);
  expect(parseExitObject(`{ "note": "unclosed {"\n${JSON.stringify(success)}`)).toEqual(success);
});

test("Cursor's out-of-usage refusal is an allowance signal, not a tool fault", () => {
  const stderr =
    "ActionRequiredError: Increase limits for faster responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.";
  expect(textSignals(stderr).allowance).toBe(true);
  expect(textSignals('Error: Connection stalled').allowance).toBe(false);
});
