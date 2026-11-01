import { notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { SessionEnv } from '../../session/client';
import { GLOBAL } from './subject-ratings';
import { POPULATION_LIMIT, readRatingPopulations, type PopulationInput } from './subject-rating-populations';

const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function validatePopulationInput(value: PopulationInput): PopulationInput {
  if (
    !value ||
    !uuid(value.id) ||
    !uuid(value.question) ||
    typeof value.locale !== 'string' ||
    value.locale.length > 35 ||
    (value.expectedReader !== null &&
      (typeof value.expectedReader !== 'string' || !value.expectedReader || value.expectedReader.length > 128)) ||
    (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 4096)) ||
    (value.selected !== undefined &&
      (!Array.isArray(value.selected) ||
        value.selected.length > POPULATION_LIMIT ||
        value.selected.some((id) => !uuid(id) || id === GLOBAL) ||
        new Set(value.selected).size !== value.selected.length)) ||
    (value.selected !== undefined && value.cursor !== undefined)
  )
    throw notFound();
  return value;
}

export const readSubjectRatingPopulations = createServerFn({ method: 'GET', strict: false })
  .validator(validatePopulationInput)
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    const { env } = await import('cloudflare:workers');
    const { kernelClient } = await import('../../kernel/client');
    return readRatingPopulations(kernelClient(data.locale), request, env as Partial<SessionEnv>, data);
  });
