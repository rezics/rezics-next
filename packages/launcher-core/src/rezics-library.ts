import { createKernelClient } from '@rezics/client';
import { localeChain } from '@rezics/composition';
import {
  rezicsSubjectIdPattern,
  type Instance,
  type RezicsLibraryPage,
  type RezicsLibraryQuery,
} from '@rezics/launcher-contract';

type LibraryCredential = (signal?: AbortSignal) => string | undefined | Promise<string | undefined>;

function problemCode(value: unknown) {
  return value && typeof value === 'object' && 'code' in value ? value.code : undefined;
}

export function createRezicsLibraryReader(
  endpoint: string,
  installations: (signal: AbortSignal) => Promise<Instance[]>,
  readCredential: LibraryCredential | undefined,
  locale: string,
  fetcher?: typeof fetch,
) {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') || '/';
  const origin = url.href.replace(/\/$/, '');
  const language = localeChain(locale).join(', ');

  return async function read(query: RezicsLibraryQuery, signal?: AbortSignal): Promise<RezicsLibraryPage> {
    signal?.throwIfAborted();
    if (query.kind !== 'visual-novels' && query.kind !== 'video-games')
      throw new Error('Choose a REZICS Library shelf.');
    const type = query.kind === 'visual-novels' ? 'wd:Q689445' : 'schema:VideoGame';
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    ) {
      return { status: 'unavailable' };
    }

    const deadline = AbortSignal.timeout(15_000);
    const request = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const token = await readCredential?.(request);
      signal?.throwIfAborted();
      if (!token || !/^[A-Za-z0-9._~+/\-]+=*$/u.test(token)) return { status: 'authorization-required' };
      // The client remembers the REZICS session returned to one reader.
      const client = createKernelClient(origin, fetcher ? { fetch: fetcher } : {});
      const readPage = (view: 'FULL' | 'BASIC') =>
        client.libraryEntries.get({
          query: {
            type,
            view,
            orderBy: 'lastActivity',
            direction: 'desc',
            limit: 24,
            ...(query.cursor && { cursor: query.cursor }),
          },
          headers: { authorization: `Bearer ${token}`, 'accept-language': language },
          fetch: { signal: request, redirect: 'error', cache: 'no-store' },
        });
      const full = await readPage('FULL');
      const metadataUnavailable = full.status === 503 && problemCode(full.error?.value) === 'semantic_not_ready';
      const result = metadataUnavailable ? await readPage('BASIC') : full;
      signal?.throwIfAborted();
      if (result.status === 401) return { status: 'authorization-required' };
      if (result.status === 403) return { status: 'denied' };
      if (query.cursor && (result.status === 400 || result.status === 409)) {
        const code = problemCode(result.error?.value);
        if (code === 'invalid_cursor' || code === 'stale_cursor') return { status: 'stale-cursor' };
      }
      const page = result.data;
      if (
        !page ||
        !('libraryEntries' in page) ||
        !Array.isArray(page.libraryEntries) ||
        (page.next !== null && typeof page.next !== 'string')
      ) {
        return { status: 'unavailable' };
      }
      const bySubject = new Map<string, Instance[]>();
      let installationsUnavailable = false;
      if (page.libraryEntries.length) {
        try {
          for (const instance of await installations(request)) {
            if (!instance.subjectId) continue;
            const id = instance.subjectId.toLowerCase();
            const matching = bySubject.get(id);
            if (matching) matching.push(instance);
            else bySubject.set(id, [instance]);
          }
          request.throwIfAborted();
        } catch {
          signal?.throwIfAborted();
          if (query.installedOnly) return { status: 'installations-unavailable' };
          bySubject.clear();
          installationsUnavailable = true;
        }
      }
      const entries: Extract<RezicsLibraryPage, { status: 'ready' }>['entries'] = [];
      for (const row of page.libraryEntries) {
        if (typeof row?.subjectId !== 'string' || !rezicsSubjectIdPattern.test(row.subjectId))
          return { status: 'unavailable' };
        const matching = bySubject.get(row.subjectId.toLowerCase()) ?? [];
        if (query.installedOnly && !matching.length) continue;
        const subject = 'subject' in row && row.subject?.id === row.subjectId ? row.subject : null;
        const label = subject?.label;
        const title = typeof label === 'string' ? label : label?.value;
        entries.push({
          subjectId: row.subjectId,
          title: typeof title === 'string' && title.trim() ? title : null,
          installations: matching,
        });
      }
      signal?.throwIfAborted();
      return {
        status: 'ready',
        entries,
        next: page.next,
        ...(metadataUnavailable && { metadataUnavailable }),
        ...(installationsUnavailable && { installationsUnavailable }),
      };
    } catch {
      signal?.throwIfAborted();
      return { status: 'unavailable' };
    }
  };
}
