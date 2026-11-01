import { candidateAuthorization, expectedCandidateReader } from '../../subject/candidate-admission';
import { createServerFn } from '@tanstack/react-start';
import type { Release } from '@rezics/definitions';
import { kernelClient, requestLocale } from '../../kernel/client';
import { readRelease } from '../../subject/definitions';
import type { CandidateCommand, CandidateRead, CandidateResult } from '../../subject/candidates';
import { readContextCuration, confirmContextCuration, type ContextAddress } from './context-curation';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Context request');
  return input as Record<string, unknown>;
}
export function contextAddress(input: unknown): ContextAddress & { expectedReader: string } {
  const value = record(input);
  if (
    typeof value.id !== 'string' ||
    !uuid.test(value.id) ||
    typeof value.context !== 'string' ||
    !uuid.test(value.context)
  )
    throw new Error('Invalid subject or Context');
  if (
    value.property !== undefined &&
    (typeof value.property !== 'string' || !value.property || value.property.length > 256)
  )
    throw new Error('Invalid field');
  for (const key of ['cursor', 'session'])
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 8192))
      throw new Error('Invalid continuity');
  let slot: ContextAddress['slot'];
  if (value.slot !== undefined) {
    const raw = record(value.slot);
    if (
      Object.keys(raw).some((key) => !['target', 'sameAs', 'key'].includes(key)) ||
      (raw.target !== undefined && (typeof raw.target !== 'string' || !uuid.test(raw.target))) ||
      (raw.sameAs !== undefined &&
        (typeof raw.sameAs !== 'string' ||
          raw.sameAs.length > 8192 ||
          !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(raw.sameAs))) ||
      (raw.target !== undefined && raw.sameAs !== undefined) ||
      (raw.key !== undefined && (typeof raw.key !== 'string' || !uuid.test(raw.key) || !raw.target))
    )
      throw new Error('Invalid exact slot');
    slot = raw as ContextAddress['slot'];
  }
  return {
    expectedReader: expectedCandidateReader(input),
    id: value.id,
    context: value.context,
    ...(typeof value.property === 'string' ? { property: value.property } : {}),
    ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
    ...(typeof value.session === 'string' ? { session: value.session } : {}),
    ...(slot ? { slot } : {}),
  };
}
function command(input: unknown): CandidateCommand & { context: string } {
  const address = contextAddress(input);
  const value = record(input);
  if (
    !address.property ||
    typeof value.candidate !== 'string' ||
    !uuid.test(value.candidate) ||
    typeof value.key !== 'string' ||
    !uuid.test(value.key) ||
    !['accept', 'reject', 'adopt'].includes(String(value.operation)) ||
    (value.head !== null && (!Number.isSafeInteger(value.head) || Number(value.head) < 1))
  )
    throw new Error('Invalid confirmation');
  const mode = value.mode ?? 'replace';
  if (!['replace', 'inherit', 'suppress'].includes(String(mode))) throw new Error('Invalid selection mode');
  let selection: CandidateCommand['selection'];
  if (value.operation === 'adopt') {
    if (!Array.isArray(value.selection) || value.selection.length > 32) throw new Error('Invalid selection');
    selection = value.selection.map((input: unknown) => {
      const entry = record(input);
      if (
        typeof entry.candidate !== 'string' ||
        !uuid.test(entry.candidate) ||
        (entry.rank !== 'normal' && entry.rank !== 'preferred')
      )
        throw new Error('Invalid selected value');
      return { candidate: entry.candidate, rank: entry.rank };
    });
    if (
      new Set(selection.map((entry) => entry.candidate)).size !== selection.length ||
      (mode !== 'replace' && selection.length)
    )
      throw new Error('Invalid selection');
  }
  return {
    ...address,
    property: address.property,
    candidate: value.candidate,
    key: value.key,
    head: value.head as number | null,
    operation: value.operation as CandidateCommand['operation'],
    mode: mode as NonNullable<CandidateCommand['mode']>,
    ...(selection ? { selection } : {}),
  };
}
export const readSubjectContext = createServerFn({ method: 'POST', strict: false })
  .validator(contextAddress)
  .handler(async ({ data }): Promise<CandidateRead> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    return readContextCuration(
      kernelClient(),
      authorization,
      data,
      readRelease() as unknown as Promise<Release>,
      requestLocale() ?? 'en',
    );
  });
export const confirmSubjectContext = createServerFn({ method: 'POST', strict: false })
  .validator(command)
  .handler(async ({ data }): Promise<CandidateResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    return confirmContextCuration(
      kernelClient(),
      authorization,
      data,
      readRelease() as unknown as Promise<Release>,
      requestLocale() ?? 'en',
    );
  });
