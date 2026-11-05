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
