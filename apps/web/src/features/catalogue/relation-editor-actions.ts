import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient, requestLocale } from '../../kernel/client';
import { readRelationTypeDescriptor } from './type-directory';
import {
  confirmRelation,
  proposeRelation,
  readRelationEditor,
  validRelationSlot,
  type RelationConfirmation,
  type RelationProposal,
  type RelationRead,
  type RelationSlot,
  type RelationProposalResult,
  type RelationResult,
} from '../../subject/relation-candidates';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid relation request');
  return input as Record<string, unknown>;
}
function address(input: unknown) {
  const value = record(input);
  if (typeof value.id !== 'string' || !uuid.test(value.id) || 'context' in value) throw new Error('Invalid subject');
  let slot: RelationSlot | undefined;
  if (value.slot !== undefined) {
    const raw = record(value.slot);
    if (
      Object.keys(raw).some((key) => !['property', 'target', 'sameAs', 'key'].includes(key)) ||
      !validRelationSlot(raw as RelationSlot)
    )
      throw new Error('Invalid relation slot');
    slot = raw as RelationSlot;
  }
  if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 8192))
    throw new Error('Invalid continuation');
  if (value.session !== undefined && (typeof value.session !== 'string' || value.session.length > 16384))
    throw new Error('Invalid session token');
  return {
    id: value.id,
    ...(typeof value.session === 'string' ? { session: value.session } : {}),
    ...(slot ? { slot } : {}),
    ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
  };
}

export const readSubjectRelationEditor = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput(address))
  .handler(async ({ data }): Promise<RelationRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    try {
      return await readRelationEditor(
        kernelClient(),
        authorization,
        readRelationTypeDescriptor,
        data.id,
        requestLocale() ?? 'en',
        data.slot,
        data.cursor,
        data.session,
      );
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  });

export const proposeSubjectRelation = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((input: unknown): RelationProposal => {
      const checked = address(input);
      const value = record(input);
      if (!checked.slot || typeof value.key !== 'string' || !uuid.test(value.key)) throw new Error('Invalid proposal');
      if (value.retry !== undefined && value.retry !== true) throw new Error('Invalid retry');
      // The native release validator checks the full statement and admitted qualifiers before sending it.
      const statement = record(value.statement);
      if (!Array.isArray(statement.qualifiers) || !Array.isArray(statement.references))
        throw new Error('Invalid statement');
      return {
        id: checked.id,
        slot: checked.slot,
        key: value.key,
        statement: statement as RelationProposal['statement'],
        ...(value.retry === true ? { retry: true } : {}),
      };
    }),
  )
  .handler(async ({ data }): Promise<RelationProposalResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    try {
      return await proposeRelation(kernelClient(), authorization, readRelationTypeDescriptor, data);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  });

export const confirmSubjectRelation = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((input: unknown): RelationConfirmation => {
      const checked = address(input);
      const value = record(input);
      if (
        !checked.slot ||
        typeof value.candidate !== 'string' ||
        !uuid.test(value.candidate) ||
        typeof value.key !== 'string' ||
        !uuid.test(value.key) ||
        (value.operation !== 'accept' && value.operation !== 'reject' && value.operation !== 'adopt') ||
        (value.head !== null && (!Number.isSafeInteger(value.head) || Number(value.head) < 1)) ||
        (value.rank !== undefined && value.rank !== 'normal' && value.rank !== 'preferred')
      )
        throw new Error('Invalid confirmation');
      return {
        id: checked.id,
        slot: checked.slot,
        candidate: value.candidate,
        key: value.key,
        operation: value.operation,
        head: value.head as number | null,
        ...(checked.cursor ? { cursor: checked.cursor } : {}),
        ...(checked.session ? { session: checked.session } : {}),
        ...(value.rank ? { rank: value.rank as 'normal' | 'preferred' } : {}),
      };
    }),
  )
  .handler(async ({ data }): Promise<RelationResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    try {
      return await confirmRelation(kernelClient(), authorization, data);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  });
