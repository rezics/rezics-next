import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { readSessionIdentity } from '../../session/state';
import { readSubjectSlotSession } from '../subject-slot';
import { readSubjectLabelAssignments, searchSubjectLabels } from '../subject-labels.ts';
import { captureAnnotationCredential, originalAnnotationCredential } from '../rich-private-entry/credential';
import {
  BANGUMI_APPLY,
  BANGUMI_ROW_BYTES,
  BANGUMI_ROWS,
  BANGUMI_UPLOAD_BYTES,
  SUBJECT_ID,
  type BangumiChoice,
  type BangumiCredentialCustody,
  type BangumiApplyBody,
  type BangumiApplyCallResult,
  type BangumiCommand,
  type BangumiInspectionCommand,
  type BangumiInspectionResult,
  type BangumiMutateResult,
  type BangumiPageResult,
  type BangumiPreviewResult,
  type BangumiReviewResult,
  type BangumiScoreChoice,
  type BangumiScoreSelection,
  type BangumiLabelApplyResult,
  type BangumiLabelAssignmentsResult,
  type BangumiLabelOptionsResult,
  type BangumiLabelReviewResult,
  type BangumiTagPageResult,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScoreSelection(value: unknown): BangumiScoreSelection {
  if (!isRecord(value)) throw new Error('Invalid Bangumi score selection');
  if (value.action === 'preserve') return { action: 'preserve' };
  if (value.action === 'clear') return { action: 'clear' };
  if (value.action === 'set' && typeof value.units === 'number' && Number.isSafeInteger(value.units))
    return { action: 'set', units: value.units };
  throw new Error('Invalid Bangumi score selection');
}

function parseScoreChoice(value: unknown): BangumiScoreChoice {
  if (!isRecord(value)) throw new Error('Invalid Bangumi score choice');
  if (value.action === 'preserve') return { action: 'preserve' };
  if (value.action === 'clear' && value.consent === true) return { action: 'clear', consent: true };
  if (
    value.action === 'set' &&
    typeof value.units === 'number' &&
    Number.isSafeInteger(value.units) &&
    value.consent === true
  )
    return { action: 'set', units: value.units, consent: true };
  throw new Error('Invalid Bangumi score choice');
}

function parseChoice(value: unknown): BangumiChoice {
  if (!isRecord(value)) throw new Error('Invalid Bangumi import choice');
  const ordinal = requireOrdinal(value.ordinal);
  if (typeof value.reviewToken !== 'string' || !SUBJECT_ID.test(value.reviewToken))
    throw new Error('Invalid Bangumi import choice');
  if (value.state !== 'preserve' && value.state !== 'replace' && value.state !== 'omit')
    throw new Error('Invalid Bangumi import choice');
  if (typeof value.skip !== 'boolean') throw new Error('Invalid Bangumi import choice');
  return {
    ordinal,
    reviewToken: value.reviewToken,
    state: value.state,
    skip: value.skip,
    ...('score' in value ? { score: parseScoreChoice(value.score) } : {}),
  };
}

function parseApplyBody(value: unknown): BangumiApplyBody {
  if (!isRecord(value) || !Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > BANGUMI_APPLY)
    throw new Error('Invalid Bangumi import choice');
  return { rows: value.rows.map(parseChoice) };
}

function requireCustody(value: unknown): BangumiCredentialCustody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Bangumi label custody');
  const item = value as Record<string, unknown>;
  if (
    typeof item.viewer !== 'string' ||
    item.viewer.length === 0 ||
    item.viewer.length > 256 ||
    typeof item.csrfToken !== 'string' ||
    item.csrfToken.length === 0 ||
    item.csrfToken.length > 256 ||
    typeof item.credential !== 'string' ||
    !/^[A-Za-z0-9_-]{1,6400}$/.test(item.credential)
  )
    throw new Error('Invalid Bangumi label custody');
  return { viewer: item.viewer, csrfToken: item.csrfToken, credential: item.credential };
}

function requestWithCredential(request: Request, authorization: string): Request {
  const headers = new Headers(request.headers);
  headers.set('authorization', authorization);
  return new Request(request.url, { method: request.method, headers });
}

async function originalLabelRequest(
  uploadId: string,
  custody: BangumiCredentialCustody,
): Promise<{ request: Request; authorization: string } | { kind: 'denied' | 'unavailable' }> {
  const request = getRequest();
  const identity = await readSessionIdentity(request, env as Partial<SessionEnv>);
  if (identity.state === 'unavailable') return { kind: 'unavailable' };
  if (
    identity.state !== 'signed-in' ||
    !identity.subject ||
    !identity.csrfToken ||
    identity.subject !== custody.viewer ||
    identity.csrfToken !== custody.csrfToken
  )
    return { kind: 'denied' };
  const authorization = await originalAnnotationCredential(
    request,
    env as Partial<SessionEnv>,
    { viewer: identity.subject, csrfToken: identity.csrfToken, authorization: '' },
    { ...custody, subjectId: uploadId },
  );
  return authorization ? { authorization, request: requestWithCredential(request, authorization) } : { kind: 'denied' };
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
    const score = 'score' in input ? parseScoreSelection(input.score) : undefined;
    return {
      kind: 'review',
      uploadId: requireId(input.uploadId),
      key: requireKey(input.key),
      ordinal: requireOrdinal(input.ordinal),
      ...(target ? { target } : {}),
      ...(score ? { score } : {}),
    };
  })
  .handler(async ({ data }): Promise<BangumiReviewResult> => port().review(data));

export const applyBangumiImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<BangumiCommand, { kind: 'apply' }> => {
    if (!input || typeof input !== 'object' || !('uploadId' in input) || !('body' in input))
      throw new Error('Invalid Bangumi import');
    return { kind: 'apply', uploadId: requireId(input.uploadId), body: parseApplyBody(input.body) };
  })
  .handler(async ({ data }): Promise<BangumiApplyCallResult> => port().apply(data));

export const inspectBangumiCurrentFacts = createServerFn({ method: 'POST' })
  .validator((input: unknown): BangumiInspectionCommand => {
    if (!isRecord(input) || !('subjectId' in input) || !('questionId' in input))
      throw new Error('Invalid Bangumi current-fact request');
    const questionId = input.questionId;
    if (questionId !== null && (typeof questionId !== 'string' || !SUBJECT_ID.test(questionId)))
      throw new Error('Invalid Bangumi current-fact request');
    return { subjectId: requireId(input.subjectId), questionId };
  })
  .handler(async ({ data }): Promise<BangumiInspectionResult> => port().inspect(data));

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

export const readBangumiTags = createServerFn({ method: 'GET' })
  .validator((input: unknown): Extract<BangumiCommand, { kind: 'tags' }> => {
    if (!input || typeof input !== 'object' || !('uploadId' in input) || !('ordinal' in input) || !('after' in input))
      throw new Error('Invalid Bangumi tag page');
    const after = input.after;
    if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < -1 || after >= BANGUMI_ROW_BYTES)
      throw new Error('Invalid Bangumi tag page');
    const custody = 'custody' in input ? input.custody : undefined;
    return {
      kind: 'tags',
      uploadId: requireId(input.uploadId),
      ordinal: requireOrdinal(input.ordinal),
      after,
      ...(custody === undefined ? {} : { custody: requireCustody(custody) }),
    };
  })
  .handler(async ({ data }): Promise<BangumiTagPageResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    if (!originConfigured()) return { kind: 'unavailable' };
    let custody: BangumiCredentialCustody;
    let request: Request;
    if (data.custody) {
      const original = await originalLabelRequest(data.uploadId, data.custody);
      if ('kind' in original) return original;
      custody = data.custody;
      request = original.request;
    } else {
      const current = await readSubjectSlotSession(getRequest(), env as Partial<SessionEnv>);
      if (current.state === 'unavailable') return { kind: 'unavailable' };
      if (current.state !== 'signed-in' || !current.csrfToken) return { kind: 'denied' };
      custody = {
        viewer: current.subject,
        csrfToken: current.csrfToken,
        credential: await captureAnnotationCredential(
          getRequest(),
          env as Partial<SessionEnv>,
          { viewer: current.subject, csrfToken: current.csrfToken, authorization: current.authorization },
          data.uploadId,
        ),
      };
      request = requestWithCredential(getRequest(), current.authorization);
    }
    const result = await kernelBangumiPort(
      kernelClient(),
      request,
      env as Partial<SessionEnv>,
      originConfigured(),
    ).tags({ ...data, custody });
    return result.kind === 'tags' ? { ...result, custody } : result;
  });

export const searchBangumiLabels = createServerFn({ method: 'GET' })
  .validator((input: unknown): { query: string } => {
    if (!input || typeof input !== 'object' || !('query' in input)) throw new Error('Invalid label search');
    if (typeof input.query !== 'string' || input.query.length > 1000) throw new Error('Invalid label search');
    return { query: input.query };
  })
  .handler(async ({ data }): Promise<BangumiLabelOptionsResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const result = await searchSubjectLabels({
      client: kernelClient(),
      request: getRequest(),
      sessionEnv: env as Partial<SessionEnv>,
      query: data.query,
    });
    if (result.state === 'loaded')
      return {
        kind: 'label-options',
        labels: result.labels.map(({ id, name, revision }) => ({ id, name, revision })),
      };
    return { kind: result.state === 'signed-out' ? 'denied' : 'unavailable' };
  });

export const reviewBangumiLabels = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<BangumiCommand, { kind: 'review-labels' }> => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('uploadId' in input) ||
      !('ordinal' in input) ||
      !('rowRevision' in input) ||
      !('mappings' in input) ||
      !('key' in input) ||
      !('custody' in input)
    )
      throw new Error('Invalid Bangumi label review');
    const ordinal = requireOrdinal(input.ordinal);
    const rowRevision = requireId(input.rowRevision);
    const key = requireKey(input.key);
    const custody = requireCustody(input.custody);
    if (!Array.isArray(input.mappings) || input.mappings.length > 16) throw new Error('Invalid Bangumi label review');
    const mappings = input.mappings.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Bangumi label review');
      const mapping = value as Record<string, unknown>;
      if (
        !Number.isSafeInteger(mapping.index) ||
        (mapping.index as number) < 0 ||
        (mapping.index as number) > BANGUMI_ROW_BYTES
      )
        throw new Error('Invalid Bangumi label review');
      const target = mapping.target;
      if (!target || typeof target !== 'object' || Array.isArray(target))
        throw new Error('Invalid Bangumi label review');
      const item = target as Record<string, unknown>;
      if (typeof item.labelId === 'string' && Object.keys(item).length === 1)
        return { index: mapping.index as number, target: { labelId: requireId(item.labelId) } };
      if (typeof item.name === 'string' && item.name.length <= 8192 && Object.keys(item).length === 1)
        return { index: mapping.index as number, target: { name: item.name } };
      throw new Error('Invalid Bangumi label review');
    });
    return { kind: 'review-labels', uploadId: requireId(input.uploadId), ordinal, rowRevision, mappings, key, custody };
  })
  .handler(async ({ data }): Promise<BangumiLabelReviewResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    if (!originConfigured()) return { kind: 'unavailable' };
    const original = await originalLabelRequest(data.uploadId, data.custody);
    if ('kind' in original) return original;
    return kernelBangumiPort(
      kernelClient(),
      original.request,
      env as Partial<SessionEnv>,
      originConfigured(),
    ).reviewLabels(data);
  });

export const applyBangumiLabels = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<BangumiCommand, { kind: 'apply-labels' }> => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('uploadId' in input) ||
      !('ordinal' in input) ||
      !('reviewToken' in input) ||
      !('custody' in input)
    )
      throw new Error('Invalid Bangumi label confirmation');
    return {
      kind: 'apply-labels',
      uploadId: requireId(input.uploadId),
      ordinal: requireOrdinal(input.ordinal),
      reviewToken: requireId(input.reviewToken),
      custody: requireCustody(input.custody),
    };
  })
  .handler(async ({ data }): Promise<BangumiLabelApplyResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    if (!originConfigured()) return { kind: 'unavailable' };
    const original = await originalLabelRequest(data.uploadId, data.custody);
    if ('kind' in original) return original;
    return kernelBangumiPort(
      kernelClient(),
      original.request,
      env as Partial<SessionEnv>,
      originConfigured(),
    ).applyLabels(data);
  });

export const readBangumiLabelAssignments = createServerFn({ method: 'GET' })
  .validator((input: unknown): { subjectId: string } => {
    if (!input || typeof input !== 'object' || !('subjectId' in input))
      throw new Error('Invalid label assignment read');
    return { subjectId: requireId(input.subjectId) };
  })
  .handler(async ({ data }): Promise<BangumiLabelAssignmentsResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const identity = await readSubjectSlotSession(getRequest(), env as Partial<SessionEnv>);
    if (identity.state === 'unavailable') return { kind: 'unavailable' };
    if (identity.state !== 'signed-in') return { kind: 'denied' };
    const assignments = await readSubjectLabelAssignments(kernelClient(), data.subjectId, identity.authorization);
    return { kind: 'assignments', subjectId: data.subjectId, assignments };
  });
