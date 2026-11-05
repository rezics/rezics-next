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
import { prepareSession, sessionSubject, requestCsrfToken } from '../../session/request';
import { captureEntryRestoreCredential, originalEntryRestoreCredential } from '../entry-restore-credential';
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
    if ('labels' in body) {
      const labels = body.labels;
      if (
        !Array.isArray(labels) ||
        labels.length > 32 ||
        new TextEncoder().encode(JSON.stringify(labels)).length > 16384
      )
        throw new Error('Invalid MAL labels');
      review.labels = labels.map((item) => {
        if (
          !item ||
          typeof item !== 'object' ||
          !Number.isInteger(item.value) ||
          item.value < 0 ||
          item.value >= 32 ||
          !item.target ||
          typeof item.target !== 'object'
        )
          throw new Error('Invalid MAL labels');
        const target = item.target;
        if (typeof target.name === 'string') return { value: item.value, target: { name: target.name } };
        if (
          typeof target.labelId !== 'string' ||
          !SUBJECT_ID.test(target.labelId) ||
          !Number.isInteger(target.revision) ||
          target.revision < 1
        )
          throw new Error('Invalid MAL labels');
        return { value: item.value, target: { labelId: target.labelId, revision: target.revision } };
      });
    }
    return { kind: 'review', id: requireId(input.id), key: requireKey(input.key), input: review };
  })
  .handler(async ({ data }): Promise<MalReviewResult> => port().review(data));

function requireCustody(input: unknown): NonNullable<Extract<MalCommand, { kind: 'apply' }>['custody']> {
  if (
    !input ||
    typeof input !== 'object' ||
    !('sender' in input) ||
    typeof input.sender !== 'string' ||
    !('csrf' in input) ||
    typeof input.csrf !== 'string' ||
    !('credential' in input) ||
    typeof input.credential !== 'string' ||
    input.credential.length > 3200
  )
    throw new Error('Invalid MAL custody');
  return { sender: input.sender, csrf: input.csrf, credential: input.credential };
}

export const applyMalImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<MalCommand, { kind: 'apply' }> => {
    if (!input || typeof input !== 'object' || !('id' in input) || !('body' in input))
      throw new Error('Invalid MAL import');
    const body = input.body as MalApplyBody;
    if (!body || body.confirm !== true || !Array.isArray(body.rows) || body.rows.length === 0)
      throw new Error('Invalid MAL import');
    return {
      kind: 'apply',
      id: requireId(input.id),
      body,
      ...('custody' in input ? { custody: requireCustody(input.custody) } : {}),
    };
  })
  .handler(async ({ data }): Promise<MalApplyResult> => {
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    if (data.custody) {
      if (
        sessionSubject(request) !== data.custody.sender ||
        requestCsrfToken(request) !== data.custody.csrf ||
        request.headers.get('x-csrf-token') !== data.custody.csrf
      )
        return { kind: 'denied' };
      const authorization = await originalEntryRestoreCredential(
        request,
        env as Partial<SessionEnv>,
        data.custody.credential,
      );
      if (!authorization) return { kind: 'denied' };
      return kernelMalPort(
        kernelClient(),
        request,
        env as Partial<SessionEnv>,
        originConfigured(),
        authorization,
      ).apply(data);
    }
    return port().apply(data);
  });

export const captureMalApply = createServerFn({ method: 'POST' })
  .validator((input: Extract<MalCommand, { kind: 'apply' }>) => input)
  .handler(async ({ data }): Promise<Extract<MalCommand, { kind: 'apply' }> | { kind: 'denied' }> => {
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const sender = sessionSubject(request),
      csrf = requestCsrfToken(request);
    if (!sender || !csrf || request.headers.get('x-csrf-token') !== csrf) return { kind: 'denied' };
    const credential = await captureEntryRestoreCredential(request, env as Partial<SessionEnv>);
    if (!credential) return { kind: 'denied' };
    setResponseHeader('cache-control', 'private, no-store');
    return { ...data, custody: { sender, csrf, credential } };
  });

export const readMalAssignments = createServerFn({ method: 'GET' })
  .validator((input: { subjectId: string }) => ({ subjectId: requireId(input.subjectId) }))
  .handler(async ({ data }) => port().assignments!(data.subjectId));

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
