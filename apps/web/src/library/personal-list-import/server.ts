import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { readRelease } from '../../subject/definitions';
import { libraryStateOptions } from '../profiles';
import { VNDB_ROWS, type VndbCommand } from './contract';
import { requireVndbId as requireId, vndbReviewBody, vndbApplyBody } from './requests';
import { kernelVndbPort, readVndbTargetEntry, withVndbSession } from './native';

function originConfigured(): boolean {
  return Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN);
}

function readerClient() {
  return kernelClient(requestLocale() ?? 'en');
}

function port(sender: string) {
  setResponseHeader('cache-control', 'private, no-store');
  return kernelVndbPort(readerClient(), getRequest(), env as Partial<SessionEnv>, originConfigured(), sender);
}

function requireKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 255) throw new Error('Invalid VNDB import');
  return value;
}

function requireSender(input: unknown): string {
  if (!input || typeof input !== 'object' || !('sender' in input)) throw new Error('Invalid VNDB import');
  return requireId(input.sender);
}

export const previewVndbImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<VndbCommand, { kind: 'preview' }> & { sender: string } => {
    if (!input || typeof input !== 'object' || !('xml' in input) || typeof input.xml !== 'string' || !('key' in input))
      throw new Error('Invalid VNDB import');
    return { kind: 'preview', xml: input.xml, key: requireKey(input.key), sender: requireSender(input) };
  })
  .handler(async ({ data }) => port(data.sender).preview(data));

export const readVndbImportPage = createServerFn({ method: 'GET' })
  .validator((input: unknown): Extract<VndbCommand, { kind: 'page' }> & { sender: string } => {
    if (!input || typeof input !== 'object' || !('uploadId' in input) || !('offset' in input))
      throw new Error('Invalid VNDB import');
    const offset = input.offset;
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset >= VNDB_ROWS)
      throw new Error('Invalid VNDB import');
    return { kind: 'page', uploadId: requireId(input.uploadId), offset, sender: requireSender(input) };
  })
  .handler(async ({ data }) => port(data.sender).page(data));

export const readVndbImportSource = createServerFn({ method: 'GET' })
  .validator((input: unknown): Extract<VndbCommand, { kind: 'source' }> & { sender: string } => {
    if (!input || typeof input !== 'object' || !('uploadId' in input)) throw new Error('Invalid VNDB import');
    return { kind: 'source', uploadId: requireId(input.uploadId), sender: requireSender(input) };
  })
  .handler(async ({ data }) => port(data.sender).source(data));

export const reviewVndbImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<VndbCommand, { kind: 'review' }> & { sender: string } => {
    if (!input || typeof input !== 'object' || !('uploadId' in input) || !('key' in input) || !('body' in input))
      throw new Error('Invalid VNDB import');
    return {
      kind: 'review',
      uploadId: requireId(input.uploadId),
      key: requireKey(input.key),
      body: vndbReviewBody(input.body),
      sender: requireSender(input),
    };
  })
  .handler(async ({ data }) => port(data.sender).review(data));

export const applyVndbImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<VndbCommand, { kind: 'apply' }> & { sender: string } => {
    if (!input || typeof input !== 'object' || !('uploadId' in input) || !('body' in input))
      throw new Error('Invalid VNDB import');
    return {
      kind: 'apply',
      uploadId: requireId(input.uploadId),
      body: vndbApplyBody(input.body),
      sender: requireSender(input),
    };
  })
  .handler(async ({ data }) => port(data.sender).apply(data));

export const cancelVndbImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<VndbCommand, { kind: 'cancel' }> & { sender: string } => {
    if (!input || typeof input !== 'object' || !('uploadId' in input) || !('key' in input))
      throw new Error('Invalid VNDB import');
    return {
      kind: 'cancel',
      uploadId: requireId(input.uploadId),
      key: requireKey(input.key),
      sender: requireSender(input),
    };
  })
  .handler(async ({ data }) => port(data.sender).cancel(data));

export const deleteVndbImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<VndbCommand, { kind: 'delete' }> & { sender: string } => {
    if (!input || typeof input !== 'object' || !('uploadId' in input) || !('key' in input))
      throw new Error('Invalid VNDB import');
    return {
      kind: 'delete',
      uploadId: requireId(input.uploadId),
      key: requireKey(input.key),
      sender: requireSender(input),
    };
  })
  .handler(async ({ data }) => port(data.sender).delete(data));

/** Bounded current occurrences for the explicitly selected work; never infer a start. */
export const readVndbOccurrences = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (!input || typeof input !== 'object' || !('targetId' in input)) throw new Error('Invalid VNDB import');
    return { targetId: requireId(input.targetId), sender: requireSender(input) };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const auth = await withVndbSession(getRequest(), env as Partial<SessionEnv>, originConfigured(), data.sender);
    if ('kind' in auth) return { kind: 'unavailable' as const };
    const response = await readerClient().progressSessions.get({
      query: { subjectId: data.targetId, limit: 8 },
      headers: { authorization: auth.authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (response.error) return { kind: 'unavailable' as const };
    return { kind: 'occurrences' as const, sessions: response.data.progressSessions, next: response.data.next };
  });

/** Read current private state and released choices before consenting to an explicit match. */
export const readVndbTargetStates = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('type' in input) ||
      !('targetId' in input) ||
      typeof input.type !== 'string' ||
      input.type.length === 0 ||
      input.type.length > 128
    )
      throw new Error('Invalid VNDB target type');
    return { type: input.type, targetId: requireId(input.targetId), sender: requireSender(input) };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const entry = await readVndbTargetEntry(
      readerClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      originConfigured(),
      data.sender,
      data.targetId,
    );
    if (entry.kind !== 'target-entry') return entry;
    const release = await readRelease();
    return {
      kind: 'target' as const,
      targetId: data.targetId,
      baseline: entry.baseline,
      states: Object.hasOwn(release.types, data.type)
        ? libraryStateOptions(release, data.type, requestLocale() ?? 'en')
        : [],
    };
  });
