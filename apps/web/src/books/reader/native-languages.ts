import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import * as v from 'valibot';
import { kernelClient, hasKernelOrigin } from '../../kernel/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import { recordPageReadCacheControl } from '../../security/page-cache';
import type { SessionEnv } from '../../session/client';
import { carriesSession } from '../../session/csrf';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import { bookLanguagePreferenceSchema } from './address';
import { createHostedCatalogueApi, hostedId } from './native-api';
import { bookPublicationFromNative, bookSelectionFromNative } from './native-mapper';
import { nativeBookChapterAddressSchema, hostedBookViewerSchema } from './native-read';
import { nativeBookPreference, type BookLanguagePage, type BookLanguageResult } from './languages';
import { samePublication, type BookChapterAddress } from './source';

const input = v.strictObject({
  address: nativeBookChapterAddressSchema,
  locale: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  viewer: hostedBookViewerSchema,
  currentReleaseRevisionId: hostedId,
  currentStructureRevisionId: hostedId,
  operation: v.variant('kind', [
    v.strictObject({
      kind: v.literal('list'),
      cursor: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
    }),
    v.strictObject({ kind: v.literal('select'), preference: bookLanguagePreferenceSchema }),
  ]),
});
export type HostedBookLanguageInput = v.InferOutput<typeof input>;
type SelectedLanguage = { address: BookChapterAddress; language: string | null; title: string };
export type HostedBookLanguageResult = BookLanguageResult<BookLanguagePage | SelectedLanguage>;

/** Body-free native language metadata under the same prepared viewer and current-publication fence as the reader. */
export const readNativeHostedBookLanguages = createServerFn({ method: 'GET' })
  .validator((value: unknown) => v.parse(input, value))
  .handler(async ({ data }): Promise<HostedBookLanguageResult> => {
    const incoming = getRequest();
    setResponseHeader('cache-control', 'private, no-store');
    recordPageReadCacheControl(incoming, 'private, no-store');
    try {
      if (await prepareSession(incoming, env as Partial<SessionEnv>)) return { state: 'denied' };
      const authorization = viewerCredential(incoming),
        subject = sessionSubject(incoming);
      if (carriesSession(incoming) && !authorization) return { state: 'unavailable' };
      if (
        data.viewer.kind === 'session'
          ? !authorization || subject !== data.viewer.subject
          : authorization || subject !== undefined
      )
        return { state: 'denied' };
      if (!hasKernelOrigin()) return { state: 'unavailable' };
      const api = createHostedCatalogueApi(
        kernelClient(data.locale, authorization ?? undefined),
        authorization,
        incoming.signal,
      );
      const { publication, selection } = data.address;
      const now = await api.catalogue(publication.id, { kind: 'publication' });
      if (now.state !== 'ready') return now;
      if (
        now.value.revisionId !== data.currentReleaseRevisionId ||
        now.value.sourceRevisionId !== data.currentStructureRevisionId
      )
        return { state: 'changed' };
      const query = { kind: 'publication' as const, revisionId: publication.releaseRevisionId! };
      if (data.operation.kind === 'list') {
        if (!api.languages) return { state: 'unavailable' };
        const result = await api.languages(publication.id, selection.occurrenceId, {
          ...query,
          limit: '20',
          ...(data.operation.cursor ? { cursor: data.operation.cursor } : {}),
        });
        if (result.state !== 'ready') return result;
        const page = result.value;
        if (
          page.catalogueId !== publication.id ||
          page.revisionId !== publication.releaseRevisionId ||
          page.sourceRevisionId !== publication.structureRevisionId ||
          page.kind !== 'publication' ||
          page.occurrenceId !== selection.occurrenceId
        )
          return { state: 'changed' };
        return {
          state: 'ready',
          value: {
            choices: page.items.map((row) => ({
              language: row.language,
              title: row.title,
              selection: {
                occurrenceId: selection.occurrenceId,
                bodyLanguage: row.language,
                body: { postId: row.target.postId, revisionId: row.target.revisionId, sha256: row.target.sha256 },
              },
            })),
            nextCursor: page.nextCursor,
          },
        };
      }
      const result = await api.metadata(publication.id, selection.occurrenceId, {
        ...query,
        ...nativeBookPreference(data.operation.preference),
      });
      if (result.state !== 'ready') return result;
      const frozen = bookPublicationFromNative(result.value);
      const selected = bookSelectionFromNative(result.value.occurrence);
      if (
        !frozen ||
        !samePublication(publication, frozen) ||
        !selected ||
        selected.occurrenceId !== selection.occurrenceId
      )
        return { state: 'changed' };
      if (result.value.occurrence.availability !== 'available') return { state: 'denied' };
      return {
        state: 'ready',
        value: {
          address: { kind: 'chapter', publication, selection: selected, languagePreference: data.operation.preference },
          language: selected.bodyLanguage ?? null,
          title: result.value.occurrence.title,
        },
      };
    } catch (error) {
      return { state: isPlatformClosedError(error) ? 'denied' : 'unavailable' };
    }
  });
