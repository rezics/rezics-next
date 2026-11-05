import { expect, mock, test } from 'bun:test';
import * as start from '../.storybook/react-start';
import {
  sourceObservationHref,
  sourceObservationSelection,
} from '../src/features/catalogue/source-observation/contract';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

test('the actual Sources route retains an exact provider link through search validation and navigation', async () => {
  const { Route } = await import('../src/routes/subjects/$id_.$slug_.sources');
  const validate = Route.options.validateSearch;
  if (typeof validate !== 'function') throw new Error('Sources search validator is missing');
  const sources = '/en/subjects/00000000-0000-8000-8000-000000000042/example/sources?realm=realm-a';
  const digest = 'a'.repeat(64);
  for (const provider of ['vndb', 'bangumi']) {
    const href = sourceObservationHref(sources, provider, digest)!;
    const input = Object.fromEntries(new URL(href, 'https://site.test').searchParams);
    const search = validate(input);
    expect(search).toEqual({ realm: 'realm-a', provider, digest });
    expect(sourceObservationSelection(validate(search))).toEqual({ source: provider, digest });
  }
  for (const input of [
    { provider: 'other', digest },
    { provider: 'vndb', digest: 'invalid' },
  ]) {
    const search = validate({ realm: 'realm-a', ...input });
    expect(search).toEqual({ realm: 'realm-a' });
    expect(sourceObservationSelection(search)).toBeUndefined();
  }
});
