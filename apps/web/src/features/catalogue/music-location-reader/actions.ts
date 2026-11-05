import { expectedCandidateReader } from '../../../subject/candidate-admission';
import { createServerFn } from '@tanstack/react-start';
import { isExploreId } from '../../pages/graph-browser';
import { exploreContext } from '../../pages/graph-browser/actions';
import { readMusicLocation, type MusicLocationAddress, type MusicLocationRead } from './model';

type ReadInput = MusicLocationAddress & {
  locale: string;
  expectedReader: string | null;
};

function validate(value: unknown): ReadInput {
  if (!value || typeof value !== 'object') throw new Error('Invalid music location address');
  const input = value as Record<string, unknown>;
  if (
    typeof input.id !== 'string' ||
    !isExploreId(input.id) ||
    typeof input.context !== 'string' ||
    !isExploreId(input.context) ||
    typeof input.type !== 'string' ||
    input.type.length > 256 ||
    typeof input.revision !== 'number' ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    typeof input.release !== 'string' ||
    input.release.length > 256 ||
    typeof input.locale !== 'string' ||
    input.locale.length > 35
  )
    throw new Error('Invalid music location address');
  const stream = input.stream;
  const cursor = input.cursor;
  const session = input.session;
  if (
    (stream !== undefined && (typeof stream !== 'string' || !stream.length || stream.length > 256)) ||
    (cursor !== undefined &&
      (typeof cursor !== 'string' || !cursor.length || cursor.length > 4096 || typeof stream !== 'string')) ||
    (session !== undefined && (typeof session !== 'string' || !session.length || session.length > 16_384))
  )
    throw new Error('Invalid music location address');
  return {
    id: input.id,
    context: input.context,
    type: input.type,
    revision: input.revision,
    release: input.release,
    locale: input.locale,
    expectedReader: input.expectedReader === null ? null : expectedCandidateReader(input),
    ...(typeof stream === 'string' ? { stream } : {}),
    ...(typeof cursor === 'string' ? { cursor } : {}),
    ...(typeof session === 'string' ? { session } : {}),
  };
}

export const readSubjectMusicLocation = createServerFn({ method: 'POST', strict: false })
  .validator(validate)
  .handler(async ({ data }): Promise<MusicLocationRead> => {
    const prepared = await exploreContext(data.locale, data.expectedReader);
    if (!prepared) return { ok: false, reason: 'denied' };
    const { fetchGuideRelease } = await import('../definition-guide');
    let definitions;
    try {
      definitions = await fetchGuideRelease(
        prepared.client,
        undefined,
        prepared.authorization ? { authorization: prepared.authorization } : {},
      );
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    return readMusicLocation(prepared.client, prepared.authorization, definitions, data, data.locale);
  });
