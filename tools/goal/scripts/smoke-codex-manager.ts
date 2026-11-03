#!/usr/bin/env bun
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectPool, textInput } from '../src/app-server.ts';

const codexHome = process.env.CODEX_HOME;
if (!codexHome) throw new Error('Set CODEX_HOME to the pool to smoke test');
const cwd = resolve(import.meta.dir, '../../../.temp/codex-manager-smoke');
mkdirSync(cwd, { recursive: true });
const client = await connectPool({ id: 'smoke', codexHome });
let threadId: string | undefined;
let activeTurn: string | undefined;
client.onNotification(({ method, params }) => {
  if (params?.threadId !== threadId) return;
  if (method === 'turn/started') activeTurn = params.turn.id;
  if (method === 'turn/completed' && params.turn.id === activeTurn) activeTurn = undefined;
});
try {
  await client.initialize();
  const thread = await client.request('thread/start', {
    cwd,
    model: 'gpt-6.1-sol',
    approvalPolicy: 'never',
    sandbox: 'read-only',
    config: { model_reasoning_effort: 'low', model_auto_compact_token_limit: 300000 },
  });
  threadId = thread.thread.id;
  console.log(JSON.stringify({ step: 'viewer', command: `codex resume ${threadId} --remote ${client.endpoint}` }));
  const set = await client.request('thread/goal/set', {
    threadId,
    objective: 'Acknowledge the smoke-test instruction and wait for a steer. Do not change any files.',
    status: 'active',
    tokenBudget: 20000,
    origin: 'user',
  });
  console.log(JSON.stringify({ step: 'goal-set', threadId, goal: set.goal }));
  const turn = await client.request('turn/start', {
    threadId,
    effort: 'low',
    input: textInput(
      'This is a control-plane smoke test. Use clock.sleep to wait for a steer. Do not edit files or start other agents.',
    ),
  });
  activeTurn = turn.turn.id;
  const steer = await client.request('turn/steer', {
    threadId,
    expectedTurnId: activeTurn,
    input: textInput('Steer received. Reply with SMOKE_OK and make no tool calls.'),
  });
  console.log(JSON.stringify({ step: 'steered', result: steer }));
  console.log(JSON.stringify({ step: 'goal-read', ...(await client.request('thread/goal/get', { threadId })) }));
} finally {
  if (threadId) {
    // Pause before clearing so the tiny objective cannot auto-continue during cleanup.
    await client.request('thread/goal/set', { threadId, status: 'paused', origin: 'user' });
    if (activeTurn) {
      try {
        await client.request('turn/interrupt', { threadId, turnId: activeTurn });
      } catch {}
    }
    console.log(JSON.stringify({ step: 'goal-cleared', ...(await client.request('thread/goal/clear', { threadId })) }));
    console.log(
      JSON.stringify({ step: 'goal-after-clear', ...(await client.request('thread/goal/get', { threadId })) }),
    );
  }
  client.close();
}
