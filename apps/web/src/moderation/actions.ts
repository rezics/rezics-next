import { SESSION_HEADER, type KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { moderationCommandHeaders, validateModerationKey } from './command-intent';
import { reportActionResult, type ReportActionResult } from './report-actions';

export type ModerationCommand = (path: string, body: unknown) => Promise<unknown>;
type TakeDownInput = {
  reportId: string;
  targetKind: 'board' | 'thread' | 'post';
  targetId: string;
  reason: string;
};
type DismissInput = { reportId: string };
type ResolveAppealInput = { id: string; outcome: 'uphold' | 'reverse'; statement: string; nativeSession?: string };
export type AppealResolutionResult =
  | { state: 'resolved'; outcome: 'uphold' | 'reverse'; statement: string }
  | { state: 'forbidden' }
  | { state: 'conflict' };

export function reportDecisionReason(reason: string): string {
  const value = reason.trim();
  if (!value || Array.from(value).length > 1024) throw new Error('A reason of 1 to 1024 characters is required');
  return value;
}

export async function takeDownReport(command: ModerationCommand, input: TakeDownInput): Promise<unknown> {
  const path = input.targetKind === 'board' ? 'boards' : `${input.targetKind}s`;
  return command(`/v1/${path}/${input.targetId}:takeDown`, {
    reason: reportDecisionReason(input.reason),
  });
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

/** Keeps native authorization and conflict results serializable across the server-function boundary. */
export async function submitModerationAppealResolution(
  command: ModerationCommand,
  input: ResolveAppealInput,
): Promise<AppealResolutionResult> {
  try {
    return { state: 'resolved', ...(await resolveModerationAppeal(command, input)) };
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error) {
      const status = Number(error.status);
      if (status === 403) return { state: 'forbidden' };
      if (status === 409) return { state: 'conflict' };
    }
    throw error;
  }
}

export type ReportActionInput = { reportId: string; idempotencyKey: string } & (
  | { action: 'dismiss' }
  | {
      action: 'take-down';
      targetKind: 'board' | 'thread' | 'post';
      targetId: string;
      reason: string;
    }
);

export async function sendModerationReportAction(
  client: KernelClient,
  data: ReportActionInput,
  authorization: string,
): Promise<ReportActionResult> {
  const headers = moderationCommandHeaders(authorization, data.idempotencyKey);
  if (data.action === 'dismiss') {
    const result = await client.reports({ id: data.reportId }).$dismiss.post({}, { headers });
    return reportActionResult(result.status, result.error?.value);
  }
  const command =
    data.targetKind === 'board' ? client.boards : data.targetKind === 'thread' ? client.threads : client.posts;
  const result = await command({ id: data.targetId }).$takeDown.post(
    { reason: reportDecisionReason(data.reason) },
    { headers },
  );
  return reportActionResult(result.status, result.error?.value);
}

export async function sendModerationAppealResolution(
  client: KernelClient,
  data: ResolveAppealInput & { idempotencyKey: string },
  authorization: string,
): Promise<AppealResolutionResult> {
  return submitModerationAppealResolution(async () => {
    const result = await client['moderation-appeals']({ id: data.id }).$resolve.post(
      { outcome: data.outcome, statement: data.statement },
      {
        headers: {
          ...moderationCommandHeaders(authorization, data.idempotencyKey),
          ...(data.nativeSession ? { [SESSION_HEADER]: data.nativeSession } : {}),
        },
      },
    );
    if (result.error) throw Object.assign(new Error('Appeal resolution failed'), { status: result.status });
    return result.data;
  }, data);
}

export const actionOnReport = createServerFn({ method: 'POST' })
  .validator((input: unknown): ReportActionInput => {
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
    if (value.action === 'take-down' && typeof value.reason !== 'string') throw new Error('A reason is required');
    const idempotencyKey = validateModerationKey(value.idempotencyKey);
    if (value.action === 'dismiss') return { action: 'dismiss', reportId: value.reportId, idempotencyKey };
    if (
      (value.targetKind !== 'board' && value.targetKind !== 'thread' && value.targetKind !== 'post') ||
      typeof value.targetId !== 'string' ||
      typeof value.reason !== 'string'
    )
      throw new Error('Invalid moderation action');
    return {
      action: 'take-down',
      reportId: value.reportId,
      idempotencyKey,
      targetKind: value.targetKind,
      targetId: value.targetId,
      reason: reportDecisionReason(value.reason),
    };
  })
  .handler(async ({ data }): Promise<ReportActionResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) return { ok: false, state: 'sign-in' };
    return sendModerationReportAction(kernelClient(), data, authorization);
  });

export const actionOnAppeal = createServerFn({ method: 'POST' })
  .validator((input: unknown): ResolveAppealInput & { idempotencyKey: string } => {
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
    if (
      value.nativeSession !== undefined &&
      (typeof value.nativeSession !== 'string' ||
        !value.nativeSession ||
        value.nativeSession.length > 65536 ||
        /[\r\n]/.test(value.nativeSession))
    )
      throw new Error('Invalid native appeal session');
    return {
      ...(typeof value.nativeSession === 'string' ? { nativeSession: value.nativeSession } : {}),
      id: value.id,
      outcome: value.outcome,
      statement: value.statement.trim(),
      idempotencyKey: validateModerationKey(value.idempotencyKey),
    };
  })
  .handler(async ({ data }): Promise<AppealResolutionResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) throw new Error('Sign in required');
    return sendModerationAppealResolution(kernelClient(), data, authorization);
  });
