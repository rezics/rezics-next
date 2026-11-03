import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import {
  BANGUMI_APPLY,
  BANGUMI_ROWS,
  BANGUMI_UPLOAD_BYTES,
  SUBJECT_ID,
  type BangumiApplyBody,
  type BangumiApplyCallResult,
  type BangumiCommand,
  type BangumiMutateResult,
  type BangumiPageResult,
  type BangumiPreviewResult,
  type BangumiReviewResult,
} from './contract';
import { kernelBangumiPort } from './native';

function originConfigured(): boolean {
  return Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN);
}

function port() {
  setResponseHeader('cache-control', 'private, no-store');
  return kernelBangumiPort(kernelClient(), getRequest(), env as Partial<SessionEnv>, originConfigured());
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !SUBJECT_ID.test(value)) throw new Error('Invalid Bangumi import');
  return value;
}

function requireKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 255) throw new Error('Invalid Bangumi import');
  return value;
}

function requireOrdinal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= BANGUMI_ROWS)
    throw new Error('Invalid Bangumi import');
  return value;
}

export const previewBangumiImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<BangumiCommand, { kind: 'preview' }> => {
    if (!input || typeof input !== 'object' || !('upload' in input) || !('key' in input))
      throw new Error('Invalid Bangumi import');
    const upload = input.upload;
    if (typeof upload !== 'string' || upload.length === 0) throw new Error('Invalid Bangumi import');
    if (new TextEncoder().encode(upload).length > BANGUMI_UPLOAD_BYTES) throw new Error('Invalid Bangumi import');
    return { kind: 'preview', upload, key: requireKey(input.key) };
  })
  .handler(async ({ data }): Promise<BangumiPreviewResult> => port().preview(data));

export const readBangumiImportPage = createServerFn({ method: 'GET' })
  .validator((input: unknown): Extract<BangumiCommand, { kind: 'page' }> => {
    if (!input || typeof input !== 'object' || !('uploadId' in input) || !('after' in input))
      throw new Error('Invalid Bangumi import');
    const after = input.after;
    if (typeof after !== 'number' || !Number.isInteger(after) || after < -1 || after >= BANGUMI_ROWS)
      throw new Error('Invalid Bangumi import');
    return { kind: 'page', uploadId: requireId(input.uploadId), after };
  })
  .handler(async ({ data }): Promise<BangumiPageResult> => port().page(data));

export const reviewBangumiImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<BangumiCommand, { kind: 'review' }> => {
    if (!input || typeof input !== 'object' || !('uploadId' in input) || !('key' in input) || !('ordinal' in input))
      throw new Error('Invalid Bangumi import');
    const target = 'target' in input ? input.target : undefined;
    if (target !== undefined && (typeof target !== 'string' || !SUBJECT_ID.test(target)))
      throw new Error('Invalid Bangumi import');
    return {
      kind: 'review',
      uploadId: requireId(input.uploadId),
      key: requireKey(input.key),
      ordinal: requireOrdinal(input.ordinal),
      ...(target ? { target } : {}),
    };
  })
  .handler(async ({ data }): Promise<BangumiReviewResult> => port().review(data));

export const applyBangumiImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<BangumiCommand, { kind: 'apply' }> => {
    if (!input || typeof input !== 'object' || !('uploadId' in input) || !('body' in input))
      throw new Error('Invalid Bangumi import');
    const body = input.body as BangumiApplyBody;
    if (!body || !Array.isArray(body.rows) || body.rows.length === 0 || body.rows.length > BANGUMI_APPLY)
      throw new Error('Invalid Bangumi import');
    return { kind: 'apply', uploadId: requireId(input.uploadId), body };
  })
  .handler(async ({ data }): Promise<BangumiApplyCallResult> => port().apply(data));

export const cancelBangumiImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<BangumiCommand, { kind: 'cancel' }> => {
    if (!input || typeof input !== 'object' || !('uploadId' in input) || !('key' in input))
      throw new Error('Invalid Bangumi import');
    return { kind: 'cancel', uploadId: requireId(input.uploadId), key: requireKey(input.key) };
  })
  .handler(async ({ data }): Promise<BangumiMutateResult> => port().cancel(data));

export const deleteBangumiImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<BangumiCommand, { kind: 'delete' }> => {
    if (!input || typeof input !== 'object' || !('uploadId' in input) || !('key' in input))
      throw new Error('Invalid Bangumi import');
    return { kind: 'delete', uploadId: requireId(input.uploadId), key: requireKey(input.key) };
  })
  .handler(async ({ data }): Promise<BangumiMutateResult> => port().delete(data));
