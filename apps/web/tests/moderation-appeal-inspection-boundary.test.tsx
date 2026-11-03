import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAppealResolutionIntent } from '../src/moderation/appeal-resolution/intent';
import { appealReadKey, moderationAppealInput } from '../src/moderation/appeals-read-model';
import { WorkbenchAppeal } from '../src/moderation/workbench-appeal';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { readModerationAppealPage } = await import('../src/moderation/appeals-read');
const row = {
  id: 'appeal',
  decisionId: 'decision',
  appellantId: 'private-account',
  statement: 'Restore this.',
  createdAt: '2026-11-01T00:00:00Z',
  canResolve: false,
  decision: { statement: 'Original decision.', target: { kind: 'board' as const, id: 'board' } },
};

test('1/10/20 installed rows cross the adapter and panel without identity or target reads; sparse stays sparse', async () => {
  for (const count of [1, 10, 20, 0]) {
    const calls: string[] = [];
    const client = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push(new URL(request.url).pathname);
        expect(request.cache).toBe('no-store');
        return Response.json({
          appeals: Array.from({ length: count }, (_, i) => ({ ...row, id: `appeal-${i}` })),
          next: 'opaque',
        });
      },
    });
    const page = await readModerationAppealPage(client, { boardId: 'board' }, 'Bearer viewer', 'viewer');
    expect(page.state).toBe('ready');
    expect(page.appeals).toHaveLength(count);
    expect(page.targets).toEqual([]);
    expect(page.next).toBe('opaque');
    expect(calls).toEqual(['/v1/boards/board/appeals']);
    const inspect = await readModerationAppealPage(
      client,
      { boardId: 'board', inspect: row.id },
      'Bearer viewer',
      'viewer',
    );
    expect(inspect.unavailableReason).toBe('native-appeal-inspect');
    expect(calls).toHaveLength(1);
    const markup = renderToStaticMarkup(
      createElement(WorkbenchAppeal, {
        appealId: row.id,
        page: { state: 'ready', appeals: page.appeals, selectedAppeal: row },
        queueHref: '?cursor=captured',
      }),
    );
    expect(markup).toContain('Original decision.');
    expect(markup).toContain('Restore this.');
    expect(markup).toContain('href="?cursor=captured"');
    expect(markup).not.toContain('private-account');
    const resolved = renderToStaticMarkup(
      createElement(WorkbenchAppeal, {
        appealId: row.id,
        page: {
          state: 'ready',
          appeals: [],
          selectedAppeal: {
            ...row,
            decision: {
              ...row.decision,
              appeal: { outcome: 'reversed', statement: 'Restored.', resolvedAt: row.createdAt },
            },
          },
        },
        queueHref: '?cursor=captured',
      }),
    );
    expect(resolved).toContain(m.moderation_appeal_reversed());
    expect(resolved).toContain('Restored.');
  }
});

test('inspect binds the private read identity and uncertain delivery keeps its original sender and command', async () => {
  const input = moderationAppealInput('board', { cursor: 'captured', inspect: 'appeal' });
  expect(input.inspect).toBe('appeal');
  expect(appealReadKey(input)).not.toBe(appealReadKey({ ...input, inspect: 'other' }));
  const intent = createAppealResolutionIntent('appeal');
  intent.synchronize('appeal', 'viewer-session', true);
  intent.edit('Review.');
  const calls: unknown[] = [];
  const command = intent.begin('reverse', async (original) => {
    calls.push(original);
    throw new Error('lost');
  })!;
  await expect(intent.send(command)).rejects.toThrow('lost');
  intent.uncertain();
  expect(intent.retry()).toBe(command);
  await expect(intent.send(command)).rejects.toThrow('lost');
  expect(calls.length).toBe(2);
  expect(calls.every((item) => item === command)).toBe(true);
  intent.synchronize('appeal', 'replacement-session', true);
  await expect(intent.send(command)).rejects.toThrow('unavailable');
});
