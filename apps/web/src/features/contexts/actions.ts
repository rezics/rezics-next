import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { pickText } from '@rezics/composition';
import type { EntityPickerSubject } from '@rezics/ui/entity-picker';
import { kernelClient } from '../../kernel/client';
import { coverOf, coverSubject } from '../../media/summary';
import { MediaProblem } from '../../media/kernel';
import { suggestSubjects } from '../../search/suggestions';
import { hitYear } from '../../search/results';
import { validSuggestionText } from '../../search/typeahead';
import { locales } from '../../paraglide/runtime.js';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import type { SessionEnv } from '../../session/client';
import { createContextApi } from './api';
import { contextId, directoryInput, parseAddress, parseCommand, type Failure, type Result } from './model';
import { readSettingsInventory, settingsDigest } from './settings-api';

async function viewer(): Promise<string | Failure> {
  setResponseHeader('cache-control', 'private, no-store');
  try {
    const request = getRequest();
    const stale = await prepareSession(request, env as Partial<SessionEnv>);
    // The browser's original reader is a mismatch guard, never an authorization credential.
    const expected = request.headers.get('X-Context-Reader');
    if (!expected || !contextId.test(expected) || sessionSubject(request) !== expected) return { kind: 'signed-out' };
    return (!stale && viewerCredential(request)) || { kind: 'signed-out' };
  } catch (error) {
    return error instanceof MediaProblem
      ? { kind: error.problem.status === 401 ? 'signed-out' : error.problem.status === 403 ? 'denied' : 'unavailable' }
      : { kind: 'unavailable' };
  }
}
export const readContextDirectory = createServerFn({ method: 'GET', strict: false })
  .validator((input: Record<string, unknown>) => directoryInput(input))
  .handler(async ({ data }) => {
    const authorization = await viewer();
    return typeof authorization === 'string'
      ? createContextApi(kernelClient(), authorization).list(data)
      : { page: authorization, creation: authorization };
  });
export const readContextCreation = createServerFn({ method: 'GET', strict: false }).handler(async () => {
  const authorization = await viewer();
  return typeof authorization === 'string' ? createContextApi(kernelClient(), authorization).creation() : authorization;
});
// Native read continuations are private: server-function data must travel in a body, never a URL.
export const readContextWorkspace = createServerFn({ method: 'POST', strict: false })
  .validator(parseAddress)
  .handler(async ({ data }) => {
    const authorization = await viewer();
    return typeof authorization === 'string'
      ? createContextApi(kernelClient(), authorization).detail(data.id, data.session)
      : authorization;
  });
export const changeContextWorkspace = createServerFn({ method: 'POST', strict: false })
  .validator(parseCommand)
  .handler(async ({ data }) => {
    const authorization = await viewer();
    return typeof authorization === 'string'
      ? createContextApi(kernelClient(), authorization).submit(data)
      : authorization;
  });
export const readContextSettings = createServerFn({ method: 'POST', strict: false })
  .validator((input: Record<string, unknown>) => settingsDigest(input))
  .handler(async ({ data }) => {
    const authorization = await viewer();
    return typeof authorization === 'string'
      ? readSettingsInventory(kernelClient(), authorization, data.digest, data.session)
      : { kind: authorization.kind === 'denied' || authorization.kind === 'signed-out' ? 'denied' : 'unavailable' };
  });

/** The ordinary bounded suggestion reader, admitted for this Context visit's original reader. */
export const readContextTargets = createServerFn({ method: 'GET', strict: false })
  .validator((input: { text: string; locale: string }) => {
    if (!input || !validSuggestionText(input.text) || !locales.some((locale) => locale === input.locale))
      throw new Error('Invalid Context target search');
    return { text: input.text, locale: input.locale };
  })
  .handler(async ({ data }): Promise<Result<EntityPickerSubject[]>> => {
    const authorization = await viewer();
    if (typeof authorization !== 'string') return authorization;
    const result = await suggestSubjects(data.text, getRequest(), data.locale);
    return {
      kind: 'ready',
      value: result.subjects.map((subject) => {
        const title = pickText(subject.labels, data.locale).text;
        return {
          id: subject.id,
          title,
          types: coverSubject(subject.id, title, subject.summary, subject.type).types,
          typeLabel: pickText(result.types[subject.type] ?? {}, data.locale).text,
          year: hitYear(subject.facts) ?? null,
          cover: coverOf(subject.summary),
        };
      }),
    };
  });
