import { expect, test } from 'bun:test';
import { agentAdapter } from '../agents.ts';
import { measureLog } from '../records.ts';

const grokExhausted = {
  type: 'error',
  message:
    'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}',
};
const grokAnswer = {
  text: 'Done.\nRESULT: success',
  stopReason: 'end_turn',
  sessionId: 'grok-session',
  usage: { input_tokens: 9683, cache_read_input_tokens: 28032, output_tokens: 164 },
};

test('a recognized top-level provider error retains its cause and cannot be mistaken for successful completion, while valid answers and ordinary text retain existing behavior', () => {
  for (const cli of ['grok', 'cursor'] as const) {
    const adapter = agentAdapter(cli);
    expect(adapter.failure(grokExhausted)).toContain('balance exhausted');
    expect(adapter.completed(grokExhausted)).toBe(false);
    expect(adapter.parseEvent?.(grokExhausted, false)).toBeNull();
    const failed = measureLog(JSON.stringify(grokExhausted), { adapter });
    expect(failed.failureKind).toBe('pool-exhausted');
    expect(failed.result).toContain('balance exhausted');

    const crashed = { type: 'error', message: 'Internal error: worker process crashed' };
    expect(adapter.failure(crashed)).toBe(crashed.message);
    expect(adapter.completed(crashed)).toBe(false);
    expect(measureLog(JSON.stringify(crashed), { adapter })).toMatchObject({
      failureKind: 'tool',
      result: crashed.message,
    });

    const answered = measureLog(JSON.stringify(grokAnswer, null, 2), { adapter });
    expect(answered.result).toContain('RESULT: success');
    expect(answered.session).toBe('grok-session');
    expect(answered.tokens).toEqual({ input: 37715, cached: 28032, output: 164 });
    expect(answered.failureKind).toBeNull();
    expect(adapter.completed({ type: 'result', result: answered.result })).toBe(true);
    expect(adapter.failure({ type: 'result', result: answered.result })).toBeNull();

    const ordinary = { text: 'Notes about a type:error event in the protocol.', stopReason: 'end_turn' };
    expect(adapter.failure(ordinary)).toBeNull();
    expect(measureLog(JSON.stringify(ordinary), { adapter }).failureKind).toBeNull();
    expect(measureLog(JSON.stringify(ordinary), { adapter }).result).toContain('type:error');
  }
});
