import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';

export type ModerationCommand = (path: string, body: unknown) => Promise<unknown>;
type TakeDownInput = {
  reportId: string;
  targetKind: 'board' | 'thread' | 'post';
  targetId: string;
  reason: string;
  statement: string;
};
type DismissInput = { reportId: string };

function decisionReason(reason: string, statement: string): string {
  const cleanReason = reason.trim();
  const cleanStatement = statement.trim();
  if (!cleanReason || !cleanStatement) throw new Error('A reason and statement are required');
  return `${cleanReason}\n\n${cleanStatement}`;
}

export async function takeDownReport(command: ModerationCommand, input: TakeDownInput): Promise<unknown> {
  const path = input.targetKind === 'board' ? 'boards' : `${input.targetKind}s`;
  return command(`/v1/${path}/${input.targetId}:takeDown`, { reason: decisionReason(input.reason, input.statement) });
}

export async function dismissReport(command: ModerationCommand, input: DismissInput): Promise<unknown> {
  return command(`/v1/reports/${input.reportId}:dismiss`, {});
}

export const actionOnReport = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid moderation action');
    const value = input as Record<string, unknown>;
    if (typeof value.reportId !== 'string' || value.reportId.length > 128) throw new Error('Invalid moderation action');
    if (value.action !== 'dismiss' && value.action !== 'take-down') throw new Error('Invalid moderation action');
    if (
      value.action === 'take-down' &&
      (typeof value.targetKind !== 'string' ||
        !['board', 'thread', 'post'].includes(value.targetKind) ||
        typeof value.targetId !== 'string' ||
        value.targetId.length > 128)
    )
      throw new Error('Invalid moderation target');
    if (value.action === 'take-down' && (typeof value.reason !== 'string' || typeof value.statement !== 'string'))
      throw new Error('A reason and statement are required');
    return {
      action: value.action,
      reportId: value.reportId,
      ...(value.targetKind === 'board' || value.targetKind === 'thread' || value.targetKind === 'post'
        ? { targetKind: value.targetKind, targetId: value.targetId as string }
        : {}),
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
      ...(typeof value.statement === 'string' ? { statement: value.statement } : {}),
    };
  })
  .handler(async ({ data }): Promise<{ ok: true }> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) throw new Error('Sign in required');
    const client = kernelClient() as unknown as {
      boards: (params: { id: string }) => {
        $takeDown: { post: (options: unknown) => Promise<{ data?: unknown; error?: unknown }> };
      };
      threads: (params: { id: string }) => {
        $takeDown: { post: (options: unknown) => Promise<{ data?: unknown; error?: unknown }> };
      };
      posts: (params: { id: string }) => {
        $takeDown: { post: (options: unknown) => Promise<{ data?: unknown; error?: unknown }> };
      };
      reports: (params: { id: string }) => {
        $dismiss: { post: (options: unknown) => Promise<{ data?: unknown; error?: unknown }> };
      };
    };
    const headers = { authorization, 'idempotency-key': crypto.randomUUID() };
    if (data.action === 'dismiss') {
      const result = await client.reports({ id: data.reportId }).$dismiss.post({ body: {}, headers });
      if (result.error) throw new Error('Report dismissal failed');
      return { ok: true };
    }
    const command =
      data.targetKind === 'board' ? client.boards : data.targetKind === 'thread' ? client.threads : client.posts;
    const result = await command({ id: data.targetId! }).$takeDown.post({
      body: { reason: decisionReason(data.reason ?? '', data.statement ?? '') },
      headers,
    });
    if (result.error) throw new Error('Board takedown failed');
    return { ok: true };
  });
