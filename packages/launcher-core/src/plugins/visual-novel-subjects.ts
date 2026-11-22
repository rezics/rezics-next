import { createKernelClient } from '@rezics/client';
import { localeChain, pickText } from '@rezics/composition';
import {
  maxVisualNovelSubjectQueryLength,
  rezicsSubjectIdPattern,
  type VisualNovelSubjectMatch,
} from '@rezics/launcher-contract';
import { humanText } from '../storage.ts';

const visualNovelType = 'wd:Q689445';
const linkPrefix = /^(?:https?:|file:|(?:[a-z][a-z0-9+.-]*:)?\/\/)/i;
const subjectPath = /^(?:\/[a-z0-9-]+)?\/subjects\/([^/]+)(?:\/|$)/i;

function requestOptions(signal?: AbortSignal) {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(15_000);
  return { fetch: { signal: signal ? AbortSignal.any([signal, deadline]) : deadline, redirect: 'error' as const } };
}

export function createVisualNovelSubjects(endpoint: string, website: URL, locale = 'en', fetcher?: typeof fetch) {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') || '/';
  const client = createKernelClient(url.href.replace(/\/$/, ''), fetcher ? { fetch: fetcher } : {});
  const languages = [...new Set([...localeChain(locale), 'ja', 'zh-Hans'])];

  function match({ id, type, labels }: { id: string; type: string; labels: Record<string, string> }) {
    const title = pickText(labels, locale).text;
    return type === visualNovelType && title ? { id, type, title } : null;
  }

  async function search(input: string, signal?: AbortSignal): Promise<VisualNovelSubjectMatch[]> {
    const query = humanText(input, maxVisualNovelSubjectQueryLength, 'search title or link');
    signal?.throwIfAborted();
    let id = query;
    if (linkPrefix.test(query)) {
      const link = URL.parse(query);
      if (!link || link.origin !== website.origin || link.username || link.password) return [];
      id = subjectPath.exec(link.pathname)?.[1] ?? '';
      if (!rezicsSubjectIdPattern.test(id)) return [];
    }
    if (rezicsSubjectIdPattern.test(id)) {
      const subject = await read(id.toLowerCase(), signal);
      return subject ? [subject] : [];
    }
    const result = await client.subjects.$search.post(
      {
        text: humanText(query, 120, 'search title'),
        filter: { type: { in: [visualNovelType] } },
        languages,
        limit: 8,
      },
      requestOptions(signal),
    );
    signal?.throwIfAborted();
    const data = result.data;
    if (!data || !('subjects' in data)) {
      throw new Error('REZICS visual novel search is unavailable.');
    }
    return data.subjects.flatMap((subject) => match(subject) ?? []);
  }

  async function read(id: string, signal?: AbortSignal): Promise<VisualNovelSubjectMatch | null> {
    const result = await client.subjects({ id }).get(requestOptions(signal));
    signal?.throwIfAborted();
    if (result.status === 404) return null;
    const subject = result.data?.subject;
    if (!subject) throw new Error('Could not read the linked REZICS title.');
    return subject.id === id ? match(subject) : null;
  }

  return { search, read };
}
