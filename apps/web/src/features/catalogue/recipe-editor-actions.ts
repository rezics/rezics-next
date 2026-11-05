import { parseRecipeVisit } from './recipe-current-visit';
import { originalReaderInput } from './editor-reader-input';
import { candidateAuthorization, expectedCandidateReader } from '../../subject/candidate-admission';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { MediaProblem } from '../../media/kernel';
import { readCorrectionActions } from './statement-editor';
import { proposalInput, type ProposalCommand, type ProposalResult } from './statement-editor';
import {
  createRecipe,
  proposeRecipe,
  readRecipeEditor,
  recipeUuid,
  type RecipeCommand,
  type RecipeRead,
} from './recipe-editor';
import type { CreateResult } from './create-subject';
import { pickText } from '@rezics/composition';
import {
  readCandidates,
  selectCandidate,
  type CandidateCommand,
  type CandidateRead,
  type CandidateResult,
  type CandidateSlot,
} from '../../subject/candidates';

type ReviewAddress = {
  expectedReader?: string;
  id: string;
  property: string;
  slot?: CandidateSlot;
  cursor?: string;
  session?: string;
};
function reviewAddress(input: ReviewAddress): ReviewAddress {
  if (
    !input ||
    !recipeUuid.test(input.id) ||
    typeof input.property !== 'string' ||
    input.property.length > 256 ||
    (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 8192)) ||
    (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384)) ||
    (input.slot !== undefined &&
      (!input.slot.target ||
        !recipeUuid.test(input.slot.target) ||
        Object.keys(input.slot).some((key) => key !== 'target')))
  )
    throw new Error('Invalid recipe review');
  return {
    expectedReader: expectedCandidateReader(input),
    id: input.id,
    property: input.property,
    ...(input.slot ? { slot: input.slot } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.session ? { session: input.session } : {}),
  };
}
export const loadRecipeReview = createServerFn({ method: 'POST', strict: false })
  .validator(reviewAddress)
  .handler(async ({ data }): Promise<CandidateRead> => {
    const bearer = await candidateAuthorization(data.expectedReader);
    if (!bearer) return { ok: false, reason: 'denied' };
    const client = kernelClient();
    const [editor, candidates] = await Promise.all([
      readRecipeEditor(client, requestLocale() ?? 'en', data.id),
      readCandidates(client, bearer, data.id, data.property, data.cursor, data.slot, data.session),
    ]);
    if (!editor.ok || !editor.fields.includes(data.property)) return { ok: false, reason: 'unavailable' };
    if (!candidates.ok) return candidates;
    return {
      ...candidates,
      fields: [
        {
          id: data.property,
          label: pickText(editor.release.properties[data.property]!.labels, requestLocale() ?? 'en').text,
          multivalued: editor.release.properties[data.property]!.multivalued,
        },
      ],
      names: Object.fromEntries(
        Object.entries(editor.release.properties).map(([id, property]) => [id, property.labels]),
      ),
    };
  });
export const confirmRecipeReview = createServerFn({ method: 'POST', strict: false })
  .validator((input: CandidateCommand): CandidateCommand => {
    const address = reviewAddress(input);
    if (
      !recipeUuid.test(input.key) ||
      !recipeUuid.test(input.candidate) ||
      !['accept', 'reject', 'adopt'].includes(input.operation) ||
      (input.head !== null && (!Number.isSafeInteger(input.head) || input.head < 1)) ||
      (input.selection !== undefined &&
        (!Array.isArray(input.selection) ||
          input.selection.length > 32 ||
          input.selection.some(
            (entry) => !entry || !recipeUuid.test(entry.candidate) || !['normal', 'preferred'].includes(entry.rank),
          )))
    )
      throw new Error('Invalid recipe decision');
    return {
      ...address,
      key: input.key,
      candidate: input.candidate,
      operation: input.operation,
      head: input.head,
      ...(input.selection ? { selection: input.selection } : {}),
    };
  })
  .handler(async ({ data }): Promise<CandidateResult> => {
    const bearer = await candidateAuthorization(data.expectedReader);
    if (!bearer) return { ok: false, reason: 'denied' };
    return selectCandidate(kernelClient(), bearer, data);
  });

export const loadRecipeEditor = createServerFn({ method: 'GET', strict: false })
  .validator((input?: string | { id: string; search: string; expectedReader?: string }) => {
    if (input === undefined) return { id: undefined, context: undefined, expectedReader: undefined };
    if (typeof input === 'string')
      return { id: recipeUuid.test(input) ? input : '', context: undefined, expectedReader: undefined };
    if (!input || !recipeUuid.test(input.id) || typeof input.search !== 'string') return null;
    const parsed = parseRecipeVisit(input.search);
    return parsed.valid
      ? {
          id: input.id,
          context: parsed.visit.context,
          expectedReader: input.expectedReader === undefined ? undefined : expectedCandidateReader(input),
        }
      : null;
  })
  .handler(async ({ data }): Promise<RecipeRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    if (!data) return { ok: false, reason: 'invalid' };
    const client = kernelClient();
    const authorization = data.expectedReader ? await candidateAuthorization(data.expectedReader) : null;
    const [read, actions] = await Promise.all([
      readRecipeEditor(client, requestLocale() ?? 'en', data.id, data.context),
      data.id ? readCorrectionActions(client, authorization ?? undefined, data.id) : undefined,
    ]);
    return read.ok && actions ? { ...read, actions } : read;
  });
type RecipeCreateRequest = RecipeCommand & { replay?: boolean };
type RecipeProposalRequest = ProposalCommand & { replay?: boolean };
type RecipeProposalSubmission = { command: ProposalCommand; replay: boolean } | { invalid: true };

function recipeProposalRequest(input: RecipeProposalRequest): RecipeProposalSubmission {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (input.replay !== undefined && typeof input.replay !== 'boolean')
  )
    return { invalid: true };
  const { replay, ...proposal } = input;
  const command = proposalInput(proposal);
  return 'invalid' in command ? command : { command, replay: replay === true };
}

export const createCatalogueRecipe = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((input: RecipeCreateRequest): RecipeCreateRequest => {
      if (
        !input ||
        !recipeUuid.test(input.key) ||
        !input.item ||
        input.item.type !== 'schema:Recipe' ||
        (input.replay !== undefined && typeof input.replay !== 'boolean')
      )
        throw new Error('Invalid recipe request');
      return { key: input.key, item: input.item, ...(input.replay === true ? { replay: true } : {}) };
    }),
  )
  .handler(async ({ data }): Promise<CreateResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    setResponseHeader('cache-control', 'private, no-store');
    const command = { key: data.key, item: data.item };
    return createRecipe(
      kernelClient(),
      getRequest(),
      env as Partial<SessionEnv>,
      command,
      requestLocale() ?? 'en',
      authorization,
      data.replay === true,
    );
  });
export const submitRecipeCorrection = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput(recipeProposalRequest))
  .handler(async ({ data }): Promise<ProposalResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    if ('invalid' in data) return { ok: false, reason: 'invalid' };
    try {
      const authorization = await candidateAuthorization(data.expectedReader);
      if (!authorization) return { ok: false, reason: 'denied' };
      return await proposeRecipe(kernelClient(), authorization, data.command, requestLocale() ?? 'en', data.replay);
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof MediaProblem && error.problem.status === 403 ? 'denied' : 'unavailable',
      };
    }
  });
