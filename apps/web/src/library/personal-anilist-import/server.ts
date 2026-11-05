import { prepareExpectedReader, validExpectedReader } from '../../session/expected-reader';
import { captureEntryRestoreCredential, originalEntryRestoreCredential } from '../entry-restore-credential';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import {
  ANILIST_APPLY,
  ANILIST_ROWS,
  ANILIST_UPLOAD_BYTES,
  SUBJECT_ID,
  isScoreFormat,
  type AniListApplyBody,
  type AniListApplyCallResult,
  type AniListCommand,
  type AniListMutateResult,
  type AniListPageResult,
  type AniListPreviewResult,
  type AniListQuestionResult,
  type AniListReviewResult,
} from './contract';
import { kernelAniListPort } from './native';

function originConfigured(): boolean {
  return Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN);
}

function port() {
  setResponseHeader('cache-control', 'private, no-store');
  return kernelAniListPort(kernelClient(), getRequest(), env as Partial<SessionEnv>, originConfigured());
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !SUBJECT_ID.test(value)) throw new Error('Invalid AniList import');
  return value;
}

function requireKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 3 || value.length > 255) throw new Error('Invalid AniList import');
  return value;
}

function requireOrdinal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= ANILIST_ROWS)
    throw new Error('Invalid AniList import');
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireConfirmations(value: unknown): AniListApplyBody['confirmations'] {
  if (!Array.isArray(value) || value.length === 0 || value.length > ANILIST_APPLY)
    throw new Error('Invalid AniList import');
  return value.map((item) => {
    if (!record(item)) throw new Error('Invalid AniList import');
    const ordinal = requireOrdinal(item.ordinal);
    const reviewId = requireId(item.reviewId);
    if (item.confirmNativeVoteEffects !== undefined && item.confirmNativeVoteEffects !== true)
      throw new Error('Invalid AniList import');
    return {
      ordinal,
      reviewId,
      ...(item.confirmNativeVoteEffects === true ? { confirmNativeVoteEffects: true as const } : {}),
    };
  });
}

export const previewAniListImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<AniListCommand, { kind: 'preview' }> => {
    if (!input || typeof input !== 'object' || !('upload' in input) || !('key' in input))
      throw new Error('Invalid AniList import');
    const upload = input.upload;
    if (typeof upload !== 'string' || upload.length === 0) throw new Error('Invalid AniList import');
    if (new TextEncoder().encode(upload).length > ANILIST_UPLOAD_BYTES) throw new Error('Invalid AniList import');
    const scoreFormat = 'scoreFormat' in input ? input.scoreFormat : undefined;
    if (scoreFormat !== undefined && !isScoreFormat(scoreFormat)) throw new Error('Invalid AniList import');
    return {
      kind: 'preview',
      upload,
      key: requireKey(input.key),
      ...(scoreFormat ? { scoreFormat } : {}),
    };
  })
  .handler(async ({ data }): Promise<AniListPreviewResult> => port().preview(data));

export const readAniListImportPage = createServerFn({ method: 'GET' })
  .validator((input: unknown): Extract<AniListCommand, { kind: 'page' }> => {
    if (!input || typeof input !== 'object' || !('importId' in input) || !('after' in input))
      throw new Error('Invalid AniList import');
    const after = input.after;
    if (typeof after !== 'number' || !Number.isInteger(after) || after < -1 || after >= ANILIST_ROWS)
      throw new Error('Invalid AniList import');
    return { kind: 'page', importId: requireId(input.importId), after };
  })
  .handler(async ({ data }): Promise<AniListPageResult> => port().page(data));

export const readAniListStandardQuestion = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AniListQuestionResult> => port().question(),
);

export const reviewAniListImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<AniListCommand, { kind: 'review' }> => {
    if (!input || typeof input !== 'object' || !('importId' in input) || !('key' in input) || !('ordinal' in input))
      throw new Error('Invalid AniList import');
    if (!('fields' in input) || !Array.isArray(input.fields) || !input.fields.every((field) => field === 'status'))
      throw new Error('Invalid AniList import');
    const subjectId = 'subjectId' in input ? input.subjectId : undefined;
    if (subjectId !== undefined && (typeof subjectId !== 'string' || !SUBJECT_ID.test(subjectId)))
      throw new Error('Invalid AniList import');
    const skip = 'skip' in input ? input.skip : undefined;
    if (skip !== undefined && typeof skip !== 'boolean') throw new Error('Invalid AniList import');
    const replace = 'replace' in input ? input.replace : false;
    if (typeof replace !== 'boolean') throw new Error('Invalid AniList import');
    const score = 'score' in input ? input.score : undefined;
    if (score !== undefined) {
      if (!record(score) || typeof score.questionId !== 'string' || !SUBJECT_ID.test(score.questionId))
        throw new Error('Invalid AniList import');
      if (!Number.isSafeInteger(score.questionRevision) || (score.questionRevision as number) < 1)
        throw new Error('Invalid AniList import');
      if (score.action === 'vote') {
        if (!Number.isSafeInteger(score.units) || (score.units as number) < 0)
          throw new Error('Invalid AniList import');
      } else if (score.action !== 'clear') throw new Error('Invalid AniList import');
    }
    return {
      kind: 'review',
      importId: requireId(input.importId),
      key: requireKey(input.key),
      ordinal: requireOrdinal(input.ordinal),
      fields: input.fields as string[],
      replace,
      ...(subjectId ? { subjectId } : {}),
      ...(skip ? { skip: true } : {}),
      ...(score === undefined
        ? {}
        : {
            score: score as Extract<
              NonNullable<Extract<AniListCommand, { kind: 'review' }>['score']>,
              { action: 'vote' | 'clear' }
            >,
          }),
    };
  })
  .handler(async ({ data }): Promise<AniListReviewResult> => port().review(data));

export const applyAniListImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<AniListCommand, { kind: 'apply' }> => {
    if (!input || typeof input !== 'object' || !('importId' in input) || !('body' in input))
      throw new Error('Invalid AniList import');
    if (!record(input.body)) throw new Error('Invalid AniList import');
    const body: AniListApplyBody = { confirmations: requireConfirmations(input.body.confirmations) };
    return { kind: 'apply', importId: requireId(input.importId), body };
  })
  .handler(async ({ data }): Promise<AniListApplyCallResult> => port().apply(data));

export const cancelAniListImport = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<AniListCommand, { kind: 'cancel' }> => {
    if (!input || typeof input !== 'object' || !('importId' in input) || !('key' in input))
      throw new Error('Invalid AniList import');
    const remove = 'remove' in input ? input.remove : false;
    if (typeof remove !== 'boolean') throw new Error('Invalid AniList import');
    return { kind: 'cancel', importId: requireId(input.importId), key: requireKey(input.key), remove };
  })
  .handler(async ({ data }): Promise<AniListMutateResult> => port().cancel(data));

// Capture the same encrypted private sender used by native Library continuations before any label effect.
export const captureAniListLabelSender = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!validExpectedReader(input)) throw new Error('Invalid AniList viewer');
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    if (!(await prepareExpectedReader(request, env as Partial<SessionEnv>, data)))
      throw new Error('AniList viewer changed');
    return captureEntryRestoreCredential(request, env as Partial<SessionEnv>);
  });

export const reviewAniListLabels = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<AniListCommand, { kind: 'review-labels' }> => {
    if (!record(input) || !record(input.body) || !validExpectedReader(input.custody))
      throw new Error('Invalid AniList label review');
    const selections = input.body.selections;
    if (!Array.isArray(selections) || selections.length < 1 || selections.length > 8)
      throw new Error('Invalid AniList selections');
    const body = {
      ordinal: requireOrdinal(input.body.ordinal),
      subjectId: requireId(input.body.subjectId),
      selections: selections.map((item) => {
        if (!record(item) || typeof item.key !== 'string' || item.key.length > 65536 || !record(item.target))
          throw new Error('Invalid AniList selection');
        const target = item.target;
        if (typeof target.labelId === 'string' && target.name === undefined)
          return { key: item.key, target: { labelId: requireId(target.labelId) } };
        if (typeof target.name === 'string' && target.labelId === undefined && target.name.length <= 65536)
          return { key: item.key, target: { name: target.name } };
        throw new Error('Invalid AniList label target');
      }),
    };
    return {
      kind: 'review-labels',
      importId: requireId(input.importId),
      key: requireKey(input.key),
      body,
      custody: labelCustody(input.custody),
    };
  })
  .handler(async ({ data }) => (await labelPort(data.custody)).reviewLabels(data));

export const applyAniListLabels = createServerFn({ method: 'POST' })
  .validator((input: unknown): Extract<AniListCommand, { kind: 'apply-labels' }> => {
    if (!record(input) || !record(input.body) || !validExpectedReader(input.custody))
      throw new Error('Invalid AniList label confirmation');
    return {
      kind: 'apply-labels',
      importId: requireId(input.importId),
      body: {
        confirmations: requireConfirmations(input.body.confirmations).map(({ ordinal, reviewId }) => ({
          ordinal,
          reviewId,
        })),
      },
      custody: labelCustody(input.custody),
    };
  })
  .handler(async ({ data }) => (await labelPort(data.custody)).applyLabels(data));

function labelCustody(input: import('./contract').AniListLabelCustody) {
  if (input.sender !== undefined && (typeof input.sender !== 'string' || input.sender.length > 3200))
    throw new Error('Invalid AniList sender');
  return input;
}
async function labelPort(custody: import('./contract').AniListLabelCustody) {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  if (!(await prepareExpectedReader(request, env as Partial<SessionEnv>, custody)))
    throw new Error('AniList viewer changed');
  const authorization = await originalEntryRestoreCredential(request, env as Partial<SessionEnv>, custody.sender);
  if (!authorization) throw new Error('AniList sender changed');
  return kernelAniListPort(kernelClient(), request, env as Partial<SessionEnv>, originConfigured(), authorization);
}

export const readAniListLabels = createServerFn({ method: 'GET' })
  .validator((input: unknown): Extract<AniListCommand, { kind: 'read-labels' }> => {
    if (!record(input) || !validExpectedReader(input.custody)) throw new Error('Invalid AniList assignment read');
    return {
      kind: 'read-labels',
      importId: requireId(input.importId),
      ordinal: requireOrdinal(input.ordinal),
      subjectId: requireId(input.subjectId),
      custody: labelCustody(input.custody),
    };
  })
  .handler(async ({ data }) => (await labelPort(data.custody)).readLabels(data));

export const searchAniListLabelTargets = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !record(input) ||
      !validExpectedReader(input.custody) ||
      typeof input.query !== 'string' ||
      input.query.length > 1000 ||
      (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 4096))
    )
      throw new Error('Invalid AniList label search');
    return {
      query: input.query,
      custody: labelCustody(input.custody),
      ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
    };
  })
  .handler(async ({ data }) => (await labelPort(data.custody)).labelTargets(data.query, data.cursor, data.custody));
