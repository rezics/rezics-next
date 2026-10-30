import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { createModerationIntent, validateModerationKey } = await import('../src/moderation/command-intent');
const { sendDecisionAppeal } = await import('../src/moderation/appeal');
const { submitModerationAppealResolution, sendModerationAppealResolution, sendModerationReportAction } =
  await import('../src/moderation/actions');
const { AppealResolution } = await import('../src/moderation/appeal-resolution');

test('lost-response retries retain the command key and commit no duplicate author appeal, report action or resolution', async () => {
  const id = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
  const decision = {
    id,
    targetKind: 'post',
    targetId: id,
    action: 'takedown',
    statement: 'Board rule.',
    decidedAt: '2026-01-01T00:00:00Z',
    appealDeadline: '2026-07-03T00:00:00Z',
    appeal: { id, outcome: null, statement: 'Please review.', resolvedAt: null },
  };
  for (const action of ['appeal', 'take-down', 'dismiss', 'reverse'] as const) {
    const form = createModerationIntent();
    const intent = { action, id, statement: 'Please review.' };
    const receipts = new Map<string, string>();
    const keys: string[] = [];
    let writes = 0;
    const client = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === 'GET') return Response.json(decision);
        expect(request.headers.get('authorization')).toBe('Bearer reviewer');
        const key = JSON.parse(request.headers.get('idempotency-key') ?? 'null');
        expect(validateModerationKey(key)).toBe(key);
        const command = request.url + (await request.text());
        keys.push(key);
        if (!receipts.has(key)) {
          receipts.set(key, command);
          writes++;
        } else expect(receipts.get(key)).toBe(command);
        if (keys.length === 1) return Response.json({ code: 'unavailable' }, { status: 503 });
        return Response.json(
          action === 'take-down'
            ? { securityRevision: '1' }
            : action === 'dismiss'
              ? { id, outcome: 'dismissed' }
              : { id },
          { status: action === 'appeal' ? 201 : 200 },
        );
      },
    });
    const send = () => {
      const idempotencyKey = form.keyFor(intent);
      if (action === 'appeal')
        return sendDecisionAppeal(client, { id, statement: intent.statement, idempotencyKey }, 'Bearer reviewer');
      if (action === 'reverse')
        return sendModerationAppealResolution(
          client,
          { id, outcome: 'reverse', statement: intent.statement, idempotencyKey },
          'Bearer reviewer',
        );
      return sendModerationReportAction(
        client,
        action === 'dismiss'
          ? { action, reportId: id, idempotencyKey }
          : {
              action,
              reportId: id,
              targetKind: 'post',
              targetId: id,
              reason: 'Rule',
              statement: intent.statement,
              idempotencyKey,
            },
        'Bearer reviewer',
      );
    };
    const first = await send().catch(() => undefined);
    expect(first === undefined || ('state' in first && first.state === 'failed')).toBe(true);
    const confirmed = await send();
    expect(confirmed).toBeDefined();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(writes).toBe(1);
    expect(form.keyFor({ ...intent, statement: 'Changed intent' })).not.toBe(keys[0]);
    form.changed();
    expect(form.keyFor(intent)).not.toBe(keys[0]);
  }
});

test('reviewers see the confirmed upheld or reversed statement and authority failures never become confirmation', async () => {
  for (const outcome of ['uphold', 'reverse'] as const) {
    const confirmed = await submitModerationAppealResolution(async () => ({ id: 'appeal' }), {
      id: 'appeal',
      outcome,
      statement: '  Independent review.  ',
    });
    if (confirmed.state !== 'resolved') throw new Error('Expected confirmed resolution');
    const html = renderToStaticMarkup(
      createElement(AppealResolution, {
        appealId: 'appeal',
        mayResolve: true,
        resolution: { outcome: confirmed.outcome === 'uphold' ? 'upheld' : 'reversed', statement: confirmed.statement },
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain(outcome === 'uphold' ? 'Decision upheld' : 'Decision reversed');
    expect(html).toContain('Independent review.');
    expect(html).not.toContain('<textarea');
  }
  for (const status of [403, 409, 404]) {
    const send = () =>
      submitModerationAppealResolution(
        async () => {
          throw Object.assign(new Error('Denied'), { status });
        },
        { id: 'appeal', outcome: 'reverse', statement: 'Review.' },
      );
    if (status === 404) await expect(send()).rejects.toThrow('Denied');
    else expect(await send()).toEqual({ state: status === 403 ? 'forbidden' : 'conflict' });
  }
});
