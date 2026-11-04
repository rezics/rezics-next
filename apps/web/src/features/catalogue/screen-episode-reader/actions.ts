import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient } from '../../../kernel/client';
import { screenSeriesId } from '../screen-episode-membership';
import { isScreenType } from '../screen-profile';
import { readScreenProfileForReader } from './read';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const loadScreenProfileForReader = createServerFn({ method: 'GET', strict: false })
  .validator((input: unknown) => {
    if (!isRecord(input)) throw new Error('Invalid Screen reader address');
    const value = input;
    const id = screenSeriesId(value.id);
    const context = value.context === undefined ? undefined : screenSeriesId(value.context);
    const expectedType = typeof value.expectedType === 'string' ? value.expectedType : undefined;
    if (
      !id ||
      !expectedType ||
      !isScreenType(expectedType) ||
      typeof value.locale !== 'string' ||
      !value.locale ||
      value.locale.length > 35 ||
      (value.context !== undefined && !context) ||
      (value.cursor !== undefined &&
        (typeof value.cursor !== 'string' || !value.cursor.length || value.cursor.length > 8192))
    )
      throw new Error('Invalid Screen reader address');
    return {
      id,
      expectedType,
      locale: value.locale,
      ...(context ? { context } : {}),
      ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
    };
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    return readScreenProfileForReader(kernelClient(), data);
  });
