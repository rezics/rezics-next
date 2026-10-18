import { expect, test } from 'bun:test';
import { personaNames } from '../support/personas.ts';
import { randomUUID } from 'node:crypto';
import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { WORK_READ_COST } from '../../../services/main/src/modules/work/read-contract.ts';
import { useBoundedReadCorpus, sessions, corpus, measured, record, raw, names, calls, delayed,
  traceHeaders, until } from '../support/bounded-read-corpus.ts';

useBoundedReadCorpus('notifications');

for (const name of personaNames) {
  test(`D5-001 ${name}: inbox and unread count share a complete request allocation`, async () => {
    const stream = await measured(sessions[name], 'GET', '/v1/me/notifications?before=latest&limit=50');
    const unread = await measured(sessions[name], 'GET', '/v1/me/notifications/unread-count');
    record({ case: 'D5-001', persona: name, assertionReached: true });
    if (name === 'visitor') {
      expect([stream.status, unread.status]).toEqual([401, 401]);
      expect(stream.body).not.toHaveProperty('items');
      return;
    }
    for (const result of [stream, unread]) {
      expect(result.status, JSON.stringify(result)).toBe(200);
      expect(result.graphCalls).toBeGreaterThan(0);
      expect(result.graphCalls).toBeLessThanOrEqual(WORK_READ_COST.graphCalls);
      expect(result.graphBytes).toBeLessThanOrEqual(WORK_READ_COST.graphBytes);
      expect(result.elapsedMs).toBeLessThan(WORK_READ_COST.deadlineMs);
    }
    const items = stream.body.items as { id: string; subject: { ref: string } | null }[];
    expect(items.length).toBeGreaterThan(0);
    expect(JSON.stringify(stream.body)).toContain(corpus.book.work);
    const alien = await sessions[name === 'stranger' ? 'operator' : 'stranger'].main('PUT',
      `/v1/me/notifications/${items[0]!.id}/read`, undefined, undefined, raw);
    expect(alien.status).toBe(404);
  }, 30_000);
}


for (const name of personaNames) {
  test(`D5-001 ${name}: personal admission and missing notification controls preserve privacy`, async () => {
    const stream = await measured(sessions[name], 'GET', '/v1/me/notifications?limit=1');
    const missing = await sessions[name].main('PUT', `/v1/me/notifications/${randomUUID()}/read`,
      undefined, undefined, raw);
    if (name === 'visitor') {
      expect(stream.status).toBe(401);
      expect(missing.status).toBe(401);
      expect(stream.body).not.toHaveProperty('items');
      record({ case: 'D5-001-admission', persona: name, assertionReached: true, denied: true });
      return;
    }
    expect(stream.status, JSON.stringify(stream)).toBe(200);
    expect(missing.status).toBe(404);
    const item = (stream.body.items as { id: string }[])[0];
    expect(item, 'The public producer created a real personal inbox item').toBeDefined();
    const alien = await sessions[name === 'stranger' ? 'operator' : 'stranger'].main('PUT',
      `/v1/me/notifications/${item!.id}/read`, undefined, undefined, raw);
    expect(alien.status).toBe(404);
    record({ case: 'D5-001-admission', persona: name, assertionReached: true,
      missingStatus: missing.status, alienStatus: alien.status });
  }, 30_000);
}

for (const name of names) {
  test(`D5-001 ${name}: leaving an inbox stops later subject reads and permits a fresh retry`, async () => {
    const { trace, headers } = traceHeaders();
    const controller = new AbortController();
    delayed.add(trace);
    const pending = context.with(propagation.extract(ROOT_CONTEXT, headers),
      () => sessions[name].main('GET', '/v1/me/notifications?before=latest&limit=50', undefined,
        undefined, { ...raw, headers, signal: controller.signal }));
    const rejected = pending.then(response => ({ status: response.status }), error => ({ aborted: String(error) }));
    try {
      await until('in-flight notification storage work', async () => calls.filter(call => call.trace === trace).length,
        count => count >= 3, 5_000);
      controller.abort();
      await rejected;
      // One in-flight exchange may finish. No next subject may start after grace.
      await Bun.sleep(100);
      const boundary = performance.now();
      await Bun.sleep(300);
      const late = calls.filter(call => call.trace === trace && call.started > boundary);
      const active = calls.filter(call => call.trace === trace && call.ended === null);
      record({ case: 'D5-001-cancel', persona: name, assertionReached: true,
        graceMs: 100, observedMs: 300, lateCalls: late.length, activeCalls: active.length });
      delayed.delete(trace);
      const retry = await measured(sessions[name], 'GET', '/v1/me/notifications?limit=1');
      record({ case: 'D5-001-retry', persona: name, status: retry.status });
      expect(retry.status).toBe(200);
      expect((retry.body.items as unknown[]).length).toBe(1);
      expect(late).toHaveLength(0);
      expect(active).toHaveLength(0);
    } finally {
      controller.abort();
      delayed.delete(trace);
      await rejected;
      // A failing cancellation assertion must not leave its abandoned request
      // competing with the next persona. Observe the defect before this drain.
      const deadline = performance.now() + 10_000;
      for (;;) {
        const length = calls.filter(call => call.trace === trace).length;
        await Bun.sleep(200);
        const traced = calls.filter(call => call.trace === trace);
        if (traced.length === length && traced.every(call => call.ended !== null)) break;
        if (performance.now() >= deadline) {
          record({ case: 'D5-001-cancel-cleanup', persona: name, quiescent: false });
          break;
        }
      }
    }
  }, 30_000);
}

