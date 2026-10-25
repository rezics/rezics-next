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
