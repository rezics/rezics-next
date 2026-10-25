import { expect, test } from 'bun:test';
import { measureLog } from './records.ts';

test('a Grok JSON result, one pretty-printed object, yields its answer, session and tokens', () => {
  const text = JSON.stringify({ text: 'Done.\nRESULT: success', stopReason: 'end_turn', sessionId: 'grok-session',
    usage: { input_tokens: 9683, cache_read_input_tokens: 28032, output_tokens: 164 } }, null, 2);
  const measured = measureLog(text);
  expect(measured.result).toContain('RESULT: success');
  expect(measured.session).toBe('grok-session');
  expect(measured.tokens).toEqual({ input: 37715, cached: 28032, output: 164 });
});

test('a blocked report wrapped in prose is still read as blocked', () => {
  const text = JSON.stringify({ text: 'I could not finish.\n{"status":"blocked","summary":"needs a decision","blocker":{"kind":"spec-conflict","detail":"the frozen test contradicts the brief"}}',
    stopReason: 'end_turn', sessionId: 's', usage: { input_tokens: 1, output_tokens: 1 } });
  const measured = measureLog(text);
  expect(measured.failureKind).toBe('spec-conflict');
  expect(measured.blocker).toBe('the frozen test contradicts the brief');
});
