import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { readRelease } from '../../subject/definitions';
import { libraryStateOptions } from '../profiles';
import {
  VNDB_APPLY,
  VNDB_ID,
  VNDB_ROWS,
  type VndbCommand,
  type VndbReviewInput,
} from './contract';
import { kernelVndbPort } from './native';

function originConfigured(): boolean {
  return Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN);
}

function port(sender: string) {
  setResponseHeader('cache-control', 'private, no-store');
  return kernelVndbPort(kernelClient(), getRequest(), env as Partial<SessionEnv>, originConfigured(), sender);
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !VNDB_ID.test(value)) throw new Error('Invalid VNDB import');
  return value;
}

function requireKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 255) throw new Error('Invalid VNDB import');
  return value;
}

function requireSender(input: unknown): string {
  if (!input || typeof input !== 'object' || !('sender' in input)) throw new Error('Invalid VNDB import');
  return requireId(input.sender);
}

function requireOrdinal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= VNDB_ROWS)
    throw new Error('Invalid VNDB import');
  return value;
}

function reviewBody(value: unknown): VndbReviewInput {
  if (!value || typeof value !== 'object' || !('ordinal' in value) || !('action' in value))
    throw new Error('Invalid VNDB import');
  const ordinal = requireOrdinal(value.ordinal);
  if (value.action === 'skip' || value.action === 'retain') return { ordinal, action: value.action };
  if (value.action !== 'state' || !('targetId' in value) || !('state' in value) || !('replace' in value))
    throw new Error('Invalid VNDB import');
  if (typeof value.state !== 'string' || !value.state || value.state.length > 255 || typeof value.replace !== 'boolean')
    throw new Error('Invalid VNDB import');
  return { ordinal, action: 'state', targetId: requireId(value.targetId), state: value.state, replace: value.replace };
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
      kind: 'review', uploadId: requireId(input.uploadId), key: requireKey(input.key), body: reviewBody(input.body),
      sender: requireSender(input),
    };
  })
  .handler(async ({ data }) => port(data.sender).review(data));

export const applyVndbImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<VndbCommand, { kind: 'apply' }> & { sender: string } => {
    if (!input || typeof input !== 'object' || !('uploadId' in input) || !('body' in input))
      throw new Error('Invalid VNDB import');
    if (!input.body || typeof input.body !== 'object' || !('rows' in input.body) || !Array.isArray(input.body.rows) ||
      input.body.rows.length === 0 || input.body.rows.length > VNDB_APPLY)
      throw new Error('Invalid VNDB import');
    const rows = input.body.rows.map((item) => {
      if (!item || typeof item !== 'object' || !('ordinal' in item) || !('reviewId' in item))
        throw new Error('Invalid VNDB import');
      return { ordinal: requireOrdinal(item.ordinal), reviewId: requireId(item.reviewId) };
    });
    return { kind: 'apply', uploadId: requireId(input.uploadId), body: { rows }, sender: requireSender(input) };
  })
  .handler(async ({ data }) => port(data.sender).apply(data));

export const cancelVndbImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<VndbCommand, { kind: 'cancel' }> & { sender: string } => {
    if (!input || typeof input !== 'object' || !('uploadId' in input) || !('key' in input))
      throw new Error('Invalid VNDB import');
    return { kind: 'cancel', uploadId: requireId(input.uploadId), key: requireKey(input.key), sender: requireSender(input) };
  })
  .handler(async ({ data }) => port(data.sender).cancel(data));

export const deleteVndbImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<VndbCommand, { kind: 'delete' }> & { sender: string } => {
    if (!input || typeof input !== 'object' || !('uploadId' in input) || !('key' in input))
      throw new Error('Invalid VNDB import');
    return { kind: 'delete', uploadId: requireId(input.uploadId), key: requireKey(input.key), sender: requireSender(input) };
  })
  .handler(async ({ data }) => port(data.sender).delete(data));

/** State labels come only from the currently released profile for the explicitly searched catalogue type. */
export const readVndbTargetStates = createServerFn({ method: 'GET' })
  .validator((input: unknown): string => {
    if (!input || typeof input !== 'object' || !('type' in input) || typeof input.type !== 'string' ||
      input.type.length === 0 || input.type.length > 128)
      throw new Error('Invalid VNDB target type');
    return input.type;
  })
  .handler(async ({ data: type }) => {
    try {
      const release = await readRelease();
      if (!Object.hasOwn(release.types, type)) return [];
      return libraryStateOptions(release, type, requestLocale() ?? 'en');
    } catch {
      return [];
    }
  });
