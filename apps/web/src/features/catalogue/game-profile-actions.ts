import { parseGameVisit, type GameCurrentVisit } from './game-current-visit';
import { originalReaderInput } from './editor-reader-input';
import { candidateAuthorization, expectedCandidateReader } from '../../subject/candidate-admission';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { pickText } from '@rezics/composition';
import { checkSubjectStructure } from '@rezics/definitions/validate';
import { kernelClient, requestLocale } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { MediaProblem } from '../../media/kernel';
import { readCandidates, type CandidateRead } from '../../subject/candidates';
import { factCommandInput, proposeFact, type FactResult } from './subject-facts';
import { createGameProfile, gameFields, gameUuid, readGameProfile, type GameCommand } from './game-profile';
import type { CreateResult } from './create-subject';

/** Creation and direct Global entry keep their original input. Source visits validate at the HTTP boundary. */
export const loadGameProfile = createServerFn({ method: 'GET', strict: false })
  .validator((input: string | undefined | { id: string; locale: string; search: string }) => {
    if (input === undefined) return { id: undefined, visit: undefined };
    if (typeof input === 'string') {
      if (!gameUuid.test(input)) throw new Error('Invalid game identity');
      return { id: input, visit: undefined };
    }
    if (!input || typeof input.id !== 'string' || !gameUuid.test(input.id) ||
      typeof input.locale !== 'string' || typeof input.search !== 'string')
      throw new Error('Invalid game visit');
    const parsed = parseGameVisit(input.search, input.id, input.locale);
    if (!parsed.valid) throw new Error('Invalid game visit');
    return { id: input.id, visit: parsed.visit as GameCurrentVisit | undefined };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return readGameProfile(kernelClient(), data.id, data.visit);
  });
export const createCatalogueGame = createServerFn({ method: 'POST', strict: false })
  .validator(
    originalReaderInput((command: GameCommand) => {
      if (
        !command ||
        typeof command.key !== 'string' ||
        !gameUuid.test(command.key) ||
        checkSubjectStructure(command.item).violations.length ||
        !command.item.statements
      )
        throw new Error('Invalid game creation');
      return command;
    }),
  )
  .handler(async ({ data }): Promise<CreateResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    setResponseHeader('cache-control', 'private, no-store');
    try {
      return await createGameProfile(
        kernelClient(),
        getRequest(),
        env as Partial<SessionEnv>,
        data,
        requestLocale() ?? 'en',
        authorization,
      );
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof MediaProblem && error.problem.status === 403 ? 'denied' : 'unavailable',
      };
    }
  });

/** Classification claims use a scalar competition slot, with the native item value and all its qualifiers. */
export const proposeGameClassification = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput(factCommandInput))
  .handler(async ({ data }): Promise<FactResult> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    if ('invalid' in data) return { ok: false, reason: 'invalid' };
    const read = await readGameProfile(kernelClient(), data.id);
    if (!read.ok) return read;
    if (
      !read.public ||
      !gameFields(read.release, read.public.subject.type).includes(data.statement.property.id) ||
      read.release.properties[data.statement.property.id]?.relation?.group !== 'classification'
    )
      return { ok: false, reason: 'invalid' };
    return proposeFact(kernelClient(), authorization, data);
  });
export const loadGameClassificationReview = createServerFn({ method: 'POST', strict: false })
  .validator((input: { id: string; property: string; cursor?: string; session?: string; expectedReader?: string }) => {
    if (
      !input ||
      typeof input.id !== 'string' ||
      !gameUuid.test(input.id) ||
      typeof input.property !== 'string' ||
      input.property.length > 256 ||
      (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 8192)) ||
      (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384))
    )
      throw new Error('Invalid classification review');
    return { ...input, expectedReader: expectedCandidateReader(input) };
  })
  .handler(async ({ data }): Promise<CandidateRead> => {
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    const client = kernelClient();
    const [read, candidates] = await Promise.all([
      readGameProfile(client, data.id),
      readCandidates(client, authorization, data.id, data.property, data.cursor, undefined, data.session),
    ]);
    if (!read.ok) return read;
    if (!candidates.ok) return candidates;
    if (
      !read.public ||
      !gameFields(read.release, read.public.subject.type).includes(data.property) ||
      read.release.properties[data.property]?.relation?.group !== 'classification'
    )
      return { ok: false, reason: 'invalid' };
    return {
      ...candidates,
      fields: [
        {
          id: data.property,
          label: pickText(read.release.properties[data.property]!.labels, requestLocale() ?? 'en').text,
          multivalued: read.release.properties[data.property]!.multivalued,
        },
      ],
      names: Object.fromEntries(Object.entries(read.release.properties).map(([id, property]) => [id, property.labels])),
    };
  });
