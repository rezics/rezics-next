import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import {
  MAL_UPLOAD_BYTES,
  SUBJECT_ID,
  type MalApplyBody,
  type MalApplyResult,
  type MalCommand,
  type MalMutateResult,
  type MalPageResult,
  type MalPreviewResult,
  type MalReviewInput,
  type MalReviewResult,
} from './contract';
import { kernelMalPort } from './native';

function originConfigured(): boolean {
  return Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN);
}

function port() {
  setResponseHeader('cache-control', 'private, no-store');
  return kernelMalPort(kernelClient(), getRequest(), env as Partial<SessionEnv>, originConfigured());
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !SUBJECT_ID.test(value)) throw new Error('Invalid MAL import');
  return value;
}

function requireKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 1024) throw new Error('Invalid MAL import');
  return value;
}

export const previewMalImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<MalCommand, { kind: 'preview' }> => {
    if (!input || typeof input !== 'object' || !('xml' in input) || !('key' in input))
      throw new Error('Invalid MAL import');
    const xml = input.xml;
    const key = requireKey(input.key);
    if (typeof xml !== 'string' || xml.length === 0) throw new Error('Invalid MAL import');
    if (new TextEncoder().encode(xml).length > MAL_UPLOAD_BYTES) throw new Error('Invalid MAL import');
    return { kind: 'preview', xml, key };
  })
  .handler(async ({ data }): Promise<MalPreviewResult> => port().preview(data));

export const readMalImportPage = createServerFn({ method: 'GET' })
  .validator((input: unknown): Extract<MalCommand, { kind: 'page' }> => {
    if (!input || typeof input !== 'object' || !('id' in input) || !('after' in input))
      throw new Error('Invalid MAL import');
    const after = input.after;
    if (typeof after !== 'number' || !Number.isInteger(after) || after < 0) throw new Error('Invalid MAL import');
    return { kind: 'page', id: requireId(input.id), after };
  })
  .handler(async ({ data }): Promise<MalPageResult> => port().page(data));

export const reviewMalImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<MalCommand, { kind: 'review' }> => {
    if (!input || typeof input !== 'object' || !('id' in input) || !('key' in input) || !('input' in input))
      throw new Error('Invalid MAL import');
    const body = input.input;
    if (
      !body ||
      typeof body !== 'object' ||
      !('row' in body) ||
      !('skip' in body) ||
      !('replace' in body) ||
      !('target' in body)
    )
      throw new Error('Invalid MAL import');
    const row = body.row;
    const target = body.target;
    if (typeof row !== 'number' || !Number.isInteger(row) || row < 0) throw new Error('Invalid MAL import');
    if (target !== null && (typeof target !== 'string' || !SUBJECT_ID.test(target)))
      throw new Error('Invalid MAL import');
    if (typeof body.skip !== 'boolean' || typeof body.replace !== 'boolean') throw new Error('Invalid MAL import');
    const review: MalReviewInput = { row, target, skip: body.skip, replace: body.replace };
    return { kind: 'review', id: requireId(input.id), key: requireKey(input.key), input: review };
  })
  .handler(async ({ data }): Promise<MalReviewResult> => port().review(data));

export const applyMalImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<MalCommand, { kind: 'apply' }> => {
    if (!input || typeof input !== 'object' || !('id' in input) || !('body' in input))
      throw new Error('Invalid MAL import');
    const body = input.body as MalApplyBody;
    if (!body || body.confirm !== true || !Array.isArray(body.rows) || body.rows.length === 0)
      throw new Error('Invalid MAL import');
    return { kind: 'apply', id: requireId(input.id), body };
  })
  .handler(async ({ data }): Promise<MalApplyResult> => port().apply(data));

export const cancelMalImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<MalCommand, { kind: 'cancel' }> => {
    if (!input || typeof input !== 'object' || !('id' in input) || !('key' in input))
      throw new Error('Invalid MAL import');
    return { kind: 'cancel', id: requireId(input.id), key: requireKey(input.key) };
  })
  .handler(async ({ data }): Promise<MalMutateResult> => port().cancel(data));

export const deleteMalImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<MalCommand, { kind: 'delete' }> => {
    if (!input || typeof input !== 'object' || !('id' in input) || !('key' in input))
      throw new Error('Invalid MAL import');
    return { kind: 'delete', id: requireId(input.id), key: requireKey(input.key) };
  })
  .handler(async ({ data }): Promise<MalMutateResult> => port().delete(data));
