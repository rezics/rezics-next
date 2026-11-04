import { originalReaderInput } from './editor-reader-input';
import { candidateAuthorization, expectedCandidateReader } from '../../subject/candidate-admission';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient } from '../../kernel/client';
import {
  readCandidates,
  selectCandidate,
  type CandidateCommand,
  type CandidateRead,
  type CandidateResult,
} from '../../subject/candidates';
import {
  proposeStatement,
  proposalInput,
  readStatementEditor,
  type EditorAddress,
  type EditorRead,
  type ProposalResult,
} from './statement-editor';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function editorAddress(value: unknown): EditorAddress {
  if (!value || typeof value !== 'object') throw new Error('Invalid correction address');
  const input = value as Record<string, unknown>;
  if (
    typeof input.id !== 'string' ||
    !uuid.test(input.id) ||
    (input.property !== undefined && (typeof input.property !== 'string' || input.property.length > 256)) ||
    (input.statement !== undefined && (typeof input.statement !== 'string' || !uuid.test(input.statement)))
  )
    throw new Error('Invalid correction address');
  return {
    id: input.id,
    ...(typeof input.property === 'string' ? { property: input.property } : {}),
    ...(typeof input.statement === 'string' ? { statement: input.statement } : {}),
  };
}

// POST actions use the existing origin, session and CSRF middleware. Credentials stay on the server.
export const readCorrection = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput(editorAddress))
  .handler(async ({ data }): Promise<EditorRead> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    return readStatementEditor(kernelClient(), data, authorization);
  });

export const submitCorrection = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput(proposalInput))
  .handler(async ({ data }): Promise<ProposalResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    if ('invalid' in data) return { ok: false, reason: 'invalid' };
    // Native proposal validation owns current Type/release/disclosure decisions and receipted replay.
    return proposeStatement(kernelClient(), authorization, data);
  });

export const readCorrectionReview = createServerFn({ method: 'POST', strict: false })
  .validator((value: unknown) => {
    const address = editorAddress(value);
    const input = value as Record<string, unknown>;
    if (
      !address.property ||
      (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 8192)) ||
      (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384))
    )
      throw new Error('Invalid correction review');
    return {
      expectedReader: expectedCandidateReader(value),
      ...address,
      property: address.property,
      cursor: input.cursor as string | undefined,
      session: input.session as string | undefined,
    };
  })
  .handler(async ({ data }): Promise<CandidateRead> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    const client = kernelClient();
    const [result, form] = await Promise.all([
      readCandidates(client, authorization, data.id, data.property, data.cursor, undefined, data.session),
      readStatementEditor(kernelClient(), { id: data.id, property: data.property }, authorization),
    ]);
    if (!result.ok) return result;
    if (!form.ok) return form;
    const { pickText } = await import('@rezics/composition');
    const { requestLocale } = await import('../../kernel/client');
    const locale = requestLocale() ?? 'en';
    return {
      ...result,
      actions: form.actions,
      fields: [
        {
          id: data.property,
          label: pickText(form.release.properties[data.property]!.labels, locale).text,
          multivalued: form.release.properties[data.property]!.multivalued,
        },
      ],
      names: Object.fromEntries(Object.entries(form.release.properties).map(([id, property]) => [id, property.labels])),
    };
  });

export const confirmCorrection = createServerFn({ method: 'POST', strict: false })
  .validator((value: unknown): CandidateCommand => {
    const address = editorAddress(value);
    const input = value as Record<string, unknown>;
    if (
      !address.property ||
      typeof input.candidate !== 'string' ||
      !uuid.test(input.candidate) ||
      typeof input.key !== 'string' ||
      !uuid.test(input.key) ||
      (input.operation !== 'accept' && input.operation !== 'adopt' && input.operation !== 'reject') ||
      (input.head !== null && (!Number.isSafeInteger(input.head) || Number(input.head) < 1)) ||
      (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384))
    )
      throw new Error('Invalid correction confirmation');
    // The shared review edits the whole selected set; dropping it would silently clear other languages/values.
    let selection: CandidateCommand['selection'];
    if (input.selection !== undefined) {
      if (!Array.isArray(input.selection) || input.selection.length > 32) throw new Error('Invalid selection');
      selection = input.selection.map((entry: unknown) => {
        if (!entry || typeof entry !== 'object') throw new Error('Invalid selection');
        const item = entry as Record<string, unknown>;
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
      id: address.id,
      property: address.property,
      candidate: input.candidate,
      key: input.key,
      operation: input.operation,
      head: input.head as number | null,
      ...(typeof input.session === 'string' ? { session: input.session } : {}),
      ...(selection ? { selection } : {}),
    };
  })
  .handler(async ({ data }): Promise<CandidateResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    return selectCandidate(kernelClient(), authorization, data);
  });
