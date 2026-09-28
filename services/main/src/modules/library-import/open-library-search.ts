/** A bounded, fixed-origin catalogue lookup. Open Library documents search.json,
 * its title/author query and selected fields at https://openlibrary.org/dev/docs/api/search. */
export const OPEN_LIBRARY_IMPORT_SEARCH_COST = { results: 6, responseBytes: 65_536,
  timeoutMs: 5_000, requests: 1 } as const;

export class OpenLibraryImportSearchUnavailable extends Error {}

export interface OpenLibraryImportCandidate { workId: string; title: string; authors: string[];
  coverId: number | null }

export async function searchOpenLibraryImport(input: { isbn?: string; title?: string; author?: string },
  fetcher: typeof fetch = fetch): Promise<OpenLibraryImportCandidate[]> {
  const isbn = input.isbn?.trim() ?? '';
  const title = input.title?.trim() ?? '';
  const author = input.author?.trim() ?? '';
  if (isbn && !/^\d{13}$/.test(isbn) || !isbn && (!title || title.length > 200 || author.length > 200)) {
    throw new OpenLibraryImportSearchUnavailable('invalid catalogue search');
  }
  const url = new URL('https://openlibrary.org/search.json');
  if (isbn) url.searchParams.set('q', `isbn:${isbn}`);
  else { url.searchParams.set('title', title); if (author) url.searchParams.set('author', author); }
  url.searchParams.set('fields', 'key,title,author_name,cover_i');
  url.searchParams.set('limit', String(OPEN_LIBRARY_IMPORT_SEARCH_COST.results));
  let response: Response;
  try {
    response = await fetcher(url.toString(), { method: 'GET', redirect: 'manual',
      signal: AbortSignal.timeout(OPEN_LIBRARY_IMPORT_SEARCH_COST.timeoutMs),
      headers: { accept: 'application/json', 'user-agent': 'REZICS-library-import/1 (book lookup)' } });
  } catch { throw new OpenLibraryImportSearchUnavailable('catalogue search failed'); }
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    throw new OpenLibraryImportSearchUnavailable('catalogue search unavailable');
  }
  if (!response.body) throw new OpenLibraryImportSearchUnavailable('empty catalogue response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > OPEN_LIBRARY_IMPORT_SEARCH_COST.responseBytes) {
        await reader.cancel();
        throw new OpenLibraryImportSearchUnavailable('catalogue response too large');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof OpenLibraryImportSearchUnavailable) throw error;
    throw new OpenLibraryImportSearchUnavailable('catalogue response was interrupted');
  } finally { reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks, size))); }
  catch { throw new OpenLibraryImportSearchUnavailable('invalid catalogue response'); }
  const docs = (body as { docs?: unknown })?.docs;
  if (!Array.isArray(docs)) throw new OpenLibraryImportSearchUnavailable('invalid catalogue response');
  return docs.slice(0, OPEN_LIBRARY_IMPORT_SEARCH_COST.results).flatMap((doc: unknown) => {
    if (!doc || typeof doc !== 'object') return [];
    const item = doc as { key?: unknown; title?: unknown; author_name?: unknown; cover_i?: unknown };
    const workId = typeof item.key === 'string' ? item.key.replace(/^\/works\//, '') : '';
    if (!/^OL[1-9][0-9]{0,11}W$/.test(workId) || typeof item.title !== 'string'
      || !item.title.trim() || item.title.length > 300 || /[\u0000-\u001f\u007f]/.test(item.title)) return [];
    const authors = Array.isArray(item.author_name)
      ? item.author_name.filter((name): name is string => typeof name === 'string' && name.length <= 200).slice(0, 3)
      : [];
    return [{ workId, title: item.title, authors,
      coverId: Number.isSafeInteger(item.cover_i) && Number(item.cover_i) > 0 ? Number(item.cover_i) : null }];
  });
}
