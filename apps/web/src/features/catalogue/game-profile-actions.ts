import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { pickText } from '@rezics/composition';
import { checkSubjectStructure } from '@rezics/definitions/validate';
import { kernelClient, requestLocale } from '../../kernel/client';
import { prepareSession, viewerCredential } from '../../session/request';
import type { SessionEnv } from '../../session/client';
import { MediaProblem } from '../../media/kernel';
import { readCandidates, type CandidateRead } from '../../subject/candidates';
import { factCommandInput, proposeFact, type FactResult } from './subject-facts';
import { createGameProfile, gameFields, gameUuid, readGameProfile, type GameCommand } from './game-profile';
import type { CreateResult } from './create-subject';

export const loadGameProfile = createServerFn({ method: 'GET', strict: false })
  .validator((id: string | undefined) => {
    if (id !== undefined && (typeof id !== 'string' || !gameUuid.test(id))) throw new Error('Invalid game identity');
    return id;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return readGameProfile(kernelClient(), data);
  });
export const createCatalogueGame = createServerFn({ method: 'POST', strict: false })
  .validator((command: GameCommand) => {
    if (
      !command ||
      typeof command.key !== 'string' ||
      !gameUuid.test(command.key) ||
      checkSubjectStructure(command.item).violations.length ||
      !command.item.statements
    )
      throw new Error('Invalid game creation');
    return command;
  })
  .handler(async ({ data }): Promise<CreateResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      return await createGameProfile(
        kernelClient(),
        getRequest(),
        env as Partial<SessionEnv>,
        data,
        requestLocale() ?? 'en',
      );
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof MediaProblem && error.problem.status === 403 ? 'denied' : 'unavailable',
      };
    }
  });
async function bearer() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  return viewerCredential(request);
}
/** Classification claims use a scalar competition slot, with the native item value and all its qualifiers. */
export const proposeGameClassification = createServerFn({ method: 'POST', strict: false })
  .validator(factCommandInput)
  .handler(async ({ data }): Promise<FactResult> => {
    const authorization = await bearer();
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
  .validator((input: { id: string; property: string; cursor?: string; session?: string }) => {
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
    return input;
  })
  .handler(async ({ data }): Promise<CandidateRead> => {
    const authorization = await bearer();
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
