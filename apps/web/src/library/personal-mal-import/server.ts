import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import {
  MAL_FIELD_CAP,
  MAL_PAGE,
  MAL_ROWS,
  MAL_UPLOAD_BYTES,
  SUBJECT_ID,
  type MalApplyBody,
  type MalApplyResult,
  type MalCommand,
  type MalMutateResult,
  type MalPageResult,
  type MalPreviewResult,
  type MalQuestionResult,
  type MalReviewInput,
  type MalReviewResult,
  type MalScoreReviewInput,
  type MalVoteReadResult,
} from './contract';
import type { SourceAdmissionCustody } from '../rich-private-entry/admission';
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

function requestCustody(input: unknown): SourceAdmissionCustody | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('custody' in input)) return undefined;
  const value = input.custody;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid MAL import');
  const fields = value as Record<string, unknown>;
  const viewer = requireId(fields.viewer);
  const csrfToken = fields.csrfToken;
  const credential = fields.credential;
  if (
    typeof csrfToken !== 'string' ||
    csrfToken.length === 0 ||
    csrfToken.length > 2048 ||
    typeof credential !== 'string' ||
    !/^[A-Za-z0-9_-]{1,6400}$/.test(credential)
  )
    throw new Error('Invalid MAL import');
  return { viewer, csrfToken, credential };
}

function commandCustody(input: unknown): { custody?: SourceAdmissionCustody } {
  const custody = requestCustody(input);
  return custody ? { custody } : {};
}

function reviewScore(value: unknown): MalScoreReviewInput {
  if (!value || typeof value !== 'object' || !('action' in value)) throw new Error('Invalid MAL import');
  if (!('questionId' in value) || !('questionRevision' in value)) throw new Error('Invalid MAL import');
  const questionId = requireId(value.questionId);
  const questionRevision = value.questionRevision;
  if (typeof questionRevision !== 'number' || !Number.isSafeInteger(questionRevision) || questionRevision < 1)
    throw new Error('Invalid MAL import');
  if (value.action === 'clear') return { action: 'clear', questionId, questionRevision };
  if (value.action !== 'adopt' || !('units' in value)) throw new Error('Invalid MAL import');
  const units = value.units;
  if (typeof units !== 'number' || !Number.isSafeInteger(units)) throw new Error('Invalid MAL import');
  if ('replaceCurrent' in value && typeof value.replaceCurrent !== 'boolean') throw new Error('Invalid MAL import');
  return {
    action: 'adopt',
    questionId,
    questionRevision,
    units,
    ...('replaceCurrent' in value && value.replaceCurrent ? { replaceCurrent: true } : {}),
  };
}

function reviewLabels(value: unknown): NonNullable<MalReviewInput['labels']> {
  if (!Array.isArray(value) || value.length > 32 || new TextEncoder().encode(JSON.stringify(value)).length > 16_384)
    throw new Error('Invalid MAL labels');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || !('value' in item) || !('target' in item))
      throw new Error('Invalid MAL labels');
    if (typeof item.value !== 'number' || !Number.isInteger(item.value) || item.value < 0 || item.value >= 32)
      throw new Error('Invalid MAL labels');
    const target = item.target;
    if (!target || typeof target !== 'object') throw new Error('Invalid MAL labels');
    if ('name' in target && typeof target.name === 'string')
      return { value: item.value, target: { name: target.name } };
    if (
      !('labelId' in target) ||
      typeof target.labelId !== 'string' ||
      !SUBJECT_ID.test(target.labelId) ||
      !('revision' in target) ||
      typeof target.revision !== 'number' ||
      !Number.isInteger(target.revision) ||
      target.revision < 1
    )
      throw new Error('Invalid MAL labels');
    return { value: item.value, target: { labelId: target.labelId, revision: target.revision } };
  });
}

export const previewMalImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<MalCommand, { kind: 'preview' }> => {
    if (!input || typeof input !== 'object' || !('xml' in input) || !('key' in input))
      throw new Error('Invalid MAL import');
    const xml = input.xml;
    const key = requireKey(input.key);
    if (typeof xml !== 'string' || xml.length === 0) throw new Error('Invalid MAL import');
    if (new TextEncoder().encode(xml).length > MAL_UPLOAD_BYTES) throw new Error('Invalid MAL import');
    return { kind: 'preview', xml, key, ...commandCustody(input) };
  })
  .handler(async ({ data }): Promise<MalPreviewResult> => port().preview(data));

export const readMalImportQuestion = createServerFn({ method: 'GET' }).handler(async (): Promise<MalQuestionResult> => {
  setResponseHeader('cache-control', 'private, no-store');
  return port().readQuestion();
});

export const readMalImportVote = createServerFn({ method: 'GET' })
  .validator((input: unknown): { targetId: string; questionId: string } => {
    if (!input || typeof input !== 'object' || !('targetId' in input) || !('questionId' in input))
      throw new Error('Invalid MAL import');
    return { targetId: requireId(input.targetId), questionId: requireId(input.questionId) };
  })
  .handler(async ({ data }): Promise<MalVoteReadResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return port().readVote(data);
  });

export const readMalImportPage = createServerFn({ method: 'GET' })
  .validator((input: unknown): Extract<MalCommand, { kind: 'page' }> => {
    if (!input || typeof input !== 'object' || !('id' in input) || !('after' in input))
      throw new Error('Invalid MAL import');
    const after = input.after;
    if (typeof after !== 'number' || !Number.isInteger(after) || after < 0) throw new Error('Invalid MAL import');
    return { kind: 'page', id: requireId(input.id), after, ...commandCustody(input) };
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
    if (typeof row !== 'number' || !Number.isInteger(row) || row < 0 || row >= MAL_ROWS)
      throw new Error('Invalid MAL import');
    if (target !== null && (typeof target !== 'string' || !SUBJECT_ID.test(target)))
      throw new Error('Invalid MAL import');
    if (typeof body.skip !== 'boolean' || typeof body.replace !== 'boolean') throw new Error('Invalid MAL import');
    const score = 'score' in body && body.score !== undefined ? reviewScore(body.score) : undefined;
    const labels = 'labels' in body && body.labels !== undefined ? reviewLabels(body.labels) : undefined;
    const review: MalReviewInput = {
      row,
      target,
      skip: body.skip,
      replace: body.replace,
      ...(labels ? { labels } : {}),
      ...(score ? { score } : {}),
    };
    return {
      kind: 'review',
      id: requireId(input.id),
      key: requireKey(input.key),
      input: review,
      ...commandCustody(input),
    };
  })
  .handler(async ({ data }): Promise<MalReviewResult> => port().review(data));

export const applyMalImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<MalCommand, { kind: 'apply' }> => {
    if (!input || typeof input !== 'object' || !('id' in input) || !('body' in input))
      throw new Error('Invalid MAL import');
    const value = input.body;
    if (!value || typeof value !== 'object' || !('confirm' in value) || !('rows' in value))
      throw new Error('Invalid MAL import');
    if (value.confirm !== true || !Array.isArray(value.rows) || value.rows.length === 0 || value.rows.length > MAL_PAGE)
      throw new Error('Invalid MAL import');
    const rows: MalApplyBody['rows'] = value.rows.map((item) => {
      if (
        !item ||
        typeof item !== 'object' ||
        !('row' in item) ||
        !('version' in item) ||
        !('fields' in item) ||
        typeof item.row !== 'number' ||
        !Number.isInteger(item.row) ||
        item.row < 0 ||
        item.row >= MAL_ROWS ||
        typeof item.version !== 'string' ||
        item.version.length < 1 ||
        item.version.length > 1024 ||
        !Array.isArray(item.fields) ||
        item.fields.length > MAL_FIELD_CAP ||
        new Set(item.fields).size !== item.fields.length ||
        item.fields.some((field) => field !== 'status' && field !== 'tags' && field !== 'score')
      )
        throw new Error('Invalid MAL import');
      return { row: item.row, version: item.version, fields: item.fields as string[] };
    });
    if (new Set(rows.map((row) => row.row)).size !== rows.length) throw new Error('Invalid MAL import');
    return { kind: 'apply', id: requireId(input.id), body: { confirm: true, rows }, ...commandCustody(input) };
  })
  .handler(async ({ data }): Promise<MalApplyResult> => port().apply(data));

export const readMalAssignments = createServerFn({ method: 'GET' })
  .validator((input: { subjectId: string }) => ({ subjectId: requireId(input.subjectId) }))
  .handler(async ({ data }) => port().assignments!(data.subjectId));

export const cancelMalImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<MalCommand, { kind: 'cancel' }> => {
    if (!input || typeof input !== 'object' || !('id' in input) || !('key' in input))
      throw new Error('Invalid MAL import');
    return { kind: 'cancel', id: requireId(input.id), key: requireKey(input.key), ...commandCustody(input) };
  })
  .handler(async ({ data }): Promise<MalMutateResult> => port().cancel(data));

export const deleteMalImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<MalCommand, { kind: 'delete' }> => {
    if (!input || typeof input !== 'object' || !('id' in input) || !('key' in input))
      throw new Error('Invalid MAL import');
    return { kind: 'delete', id: requireId(input.id), key: requireKey(input.key), ...commandCustody(input) };
  })
  .handler(async ({ data }): Promise<MalMutateResult> => port().delete(data));

export const readMalSource = createServerFn({ method: 'GET' })
  .validator((input: { id: string }) => ({ id: requireId(input.id) }))
  .handler(async ({ data }) => port().source!(data.id));
