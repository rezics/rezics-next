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
type ResolveAppealInput = { id: string; outcome: 'uphold' | 'reverse'; statement: string };
export type AppealResolutionResult =
  | { state: 'resolved'; outcome: 'uphold' | 'reverse'; statement: string }
  | { state: 'forbidden' };

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

export async function resolveModerationAppeal(
  command: ModerationCommand,
  input: ResolveAppealInput,
): Promise<{ outcome: 'uphold' | 'reverse'; statement: string }> {
  await command(`/v1/moderation-appeals/${input.id}:resolve`, {
    outcome: input.outcome,
    statement: input.statement.trim(),
  });
  return { outcome: input.outcome, statement: input.statement.trim() };
}

/** Carry a refusal as serializable data: server-function errors discard custom properties. */
export async function submitModerationAppealResolution(
  command: ModerationCommand,
  input: ResolveAppealInput,
): Promise<AppealResolutionResult> {
  try {
    return { state: 'resolved', ...(await resolveModerationAppeal(command, input)) };
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && Number(error.status) === 403)
      return { state: 'forbidden' };
    throw error;
  }
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

export const actionOnAppeal = createServerFn({ method: 'POST' })
  .validator((input: unknown): ResolveAppealInput => {
    if (!input || typeof input !== 'object') throw new Error('Invalid appeal resolution');
    const value = input as Record<string, unknown>;
    if (
      typeof value.id !== 'string' ||
      value.id.length > 128 ||
      (value.outcome !== 'uphold' && value.outcome !== 'reverse') ||
      typeof value.statement !== 'string' ||
      value.statement.trim().length === 0 ||
      Array.from(value.statement.trim()).length > 2000
    )
      throw new Error('Invalid appeal resolution');
    return { id: value.id, outcome: value.outcome, statement: value.statement.trim() };
  })
  .handler(async ({ data }): Promise<AppealResolutionResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) throw new Error('Sign in required');
    const client = kernelClient() as unknown as {
      'moderation-appeals': (params: { id: string }) => {
        $resolve: { post: (options: unknown) => Promise<{ data?: unknown; error?: unknown }> };
      };
    };
    return submitModerationAppealResolution(async (_path, body) => {
      const result = await client['moderation-appeals']({ id: data.id }).$resolve.post({
        body,
        headers: { authorization, 'idempotency-key': crypto.randomUUID() },
      });
      if (result.error) {
        const status =
          typeof result.error === 'object' && result.error !== null && 'status' in result.error
            ? Number(result.error.status)
            : undefined;
        throw Object.assign(new Error('Appeal resolution failed'), { status });
      }
      return result.data;
    }, data);
  });
