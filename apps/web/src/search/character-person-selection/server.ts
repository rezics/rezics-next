import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { readRelease } from '../../subject/definitions';
import { characterPersonSelectionMetadata } from './model';

/** Public released definitions only; all entity reads use the existing private suggestion BFF. */
export const readCharacterPersonSelectionMetadata = createServerFn({ method: 'GET' }).handler(async () => {
  const signal = getRequest().signal;
  signal.throwIfAborted();
  const release = await readRelease();
  signal.throwIfAborted();
  return characterPersonSelectionMetadata(release) ?? null;
});
