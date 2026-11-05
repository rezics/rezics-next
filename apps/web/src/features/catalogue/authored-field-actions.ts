import { SUMMARY_VISIT_ADDRESS_BYTE_CAP } from '../pages/subject-summary-reading/visit';
import { originalReaderInput } from './editor-reader-input';
import { candidateAuthorization, expectedCandidateReader } from '../../subject/candidate-admission';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient, requestLocale } from '../../kernel/client';
import { selectCandidate, type CandidateCommand, type CandidateResult } from '../../subject/candidates';
import type { ProposalResult } from './statement-editor';
import {
  proposeAuthoredField,
  readAuthoredField,
  readAuthoredReview,
  validateAuthored,
  type AuthoredAddress,
  type AuthoredCommand,
  type AuthoredRead,
  type AuthoredReview,
} from './authored-field';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid authored request');
  return value as Record<string, unknown>;
}
function address(value: unknown): AuthoredAddress {
  const input = record(value);
  if (
    typeof input.id !== 'string' ||
    !uuid.test(input.id) ||
    (input.property !== undefined && (typeof input.property !== 'string' || input.property.length > 256)) ||
    (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384)) ||
    (input.via !== undefined && (typeof input.via !== 'string' ||
      new TextEncoder().encode(input.via).byteLength > SUMMARY_VISIT_ADDRESS_BYTE_CAP))
  )
    throw new Error('Invalid authored address');
  return {
    id: input.id,
    ...(typeof input.property === 'string' ? { property: input.property } : {}),
    ...(typeof input.session === 'string' ? { session: input.session } : {}),
    ...(typeof input.via === 'string' ? { via: input.via } : {}),
  };
}

// The existing POST server-function middleware owns origin/session/CSRF checks. No credential enters the DTO.
export const loadAuthoredField = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput(address))
  .handler(async ({ data }): Promise<AuthoredRead> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    return readAuthoredField(kernelClient(), data, requestLocale() ?? 'en', authorization ?? undefined);
  });

export const submitAuthoredField = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((value: unknown): AuthoredCommand | { invalid: true } => {
      const input = record(value);
      const base = address(value);
      if (
        typeof input.key !== 'string' ||
        !uuid.test(input.key) ||
        Object.keys(input).some((key) => !['id', 'key', 'statement', 'session'].includes(key)) ||
        validateAuthored(input.statement).length
      )
        return { invalid: true };
      return {
        id: base.id,
        key: input.key,
        statement: input.statement as AuthoredCommand['statement'],
        ...(base.session ? { session: base.session } : {}),
      };
    }),
  )
  .handler(async ({ data }): Promise<ProposalResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    if ('invalid' in data) return { ok: false, reason: 'invalid' };
    return proposeAuthoredField(kernelClient(), authorization, data);
  });

export const loadAuthoredReview = createServerFn({ method: 'POST', strict: false })
  .validator((value: unknown) => {
    const base = address(value);
    const input = record(value);
    if (
      !base.property ||
      typeof input.candidate !== 'string' ||
      !uuid.test(input.candidate) ||
      (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 8192))
    )
      throw new Error('Invalid authored review');
    return {
      expectedReader: expectedCandidateReader(value),
      ...base,
      property: base.property,
      candidate: input.candidate,
      ...(typeof input.cursor === 'string' ? { cursor: input.cursor } : {}),
    };
  })
  .handler(async ({ data }): Promise<AuthoredReview> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { comparison: { ok: false, reason: 'denied' }, body: null };
    return readAuthoredReview(kernelClient(), authorization, data, requestLocale() ?? 'en');
  });

export const confirmAuthoredField = createServerFn({ method: 'POST', strict: false })
  .validator((value: unknown): CandidateCommand => {
    const base = address(value);
    const input = record(value);
    if (
      !base.property ||
      typeof input.candidate !== 'string' ||
      !uuid.test(input.candidate) ||
      typeof input.key !== 'string' ||
      !uuid.test(input.key) ||
      !['accept', 'reject', 'adopt'].includes(String(input.operation)) ||
      (input.head !== null && (!Number.isSafeInteger(input.head) || Number(input.head) < 1))
    )
      throw new Error('Invalid authored confirmation');
    let selection: CandidateCommand['selection'];
    if (input.selection !== undefined) {
      if (!Array.isArray(input.selection) || input.selection.length > 32) throw new Error('Invalid selection');
      selection = input.selection.map((entry: unknown) => {
        const item = record(entry);
        if (
          typeof item.candidate !== 'string' ||
          !uuid.test(item.candidate) ||
          (item.rank !== 'normal' && item.rank !== 'preferred')
        )
          throw new Error('Invalid selection');
        return { candidate: item.candidate, rank: item.rank };
      });
      if (new Set(selection.map((entry) => entry.candidate)).size !== selection.length)
        throw new Error('Invalid selection');
    }
    return {
      expectedReader: expectedCandidateReader(value),
      ...base,
      property: base.property,
      candidate: input.candidate,
      key: input.key,
      operation: input.operation as CandidateCommand['operation'],
      head: input.head as number | null,
      ...(selection ? { selection } : {}),
    };
  })
  .handler(async ({ data }): Promise<CandidateResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    return selectCandidate(kernelClient(), authorization, data);
  });
