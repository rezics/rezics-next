'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { RankingSkeleton } from './ranking-page.tsx';
import { rankingChart, rankingVisit, rankingVisitHost } from './ranking-visit.tsx';
import type { DiscussionQuery } from './discussion-read.ts';

/** Only a complete visit's own samples may answer this reader. No answer is edited. */
export function rankingRecording(record: AnswerRecord, persona: AnswerPersona, visit: string, loading = false,
  locale: UiLocale = 'en', onMismatch?: (error: unknown) => void) {
  const localized = `${visit}@${locale}`;
  if (locale !== 'en' && record.personas[persona].some(sample => sample.label.startsWith(`${localized}-`))) visit = localized;
  const samples = record.personas[persona].filter(sample => sample.label.startsWith(`${visit}-`)
    && /^\d+$/.test(sample.label.slice(visit.length + 1)))
    .sort((a, b) => Number(a.label.slice(visit.length + 1)) - Number(b.label.slice(visit.length + 1)));
  if (!samples.length) throw new Error(`Missing ranking visit: ${persona}/${visit}`);
  const address = samples.find(sample => sample.path.startsWith('/v1/addresses/resolve?'));
  const ref = address && new URL(address.path, 'https://recorded.invalid').searchParams.get('key');
  if (!ref) throw new Error(`Ranking visit has no address: ${persona}/${visit}`);
  const thread = samples.find(sample => new URL(sample.path, 'https://recorded.invalid').pathname.endsWith('/threads'));
  const params = new URL(thread?.path ?? '/', 'https://recorded.invalid').searchParams;
  const query: DiscussionQuery = { sort: params.get('sort') === 'top' ? 'top' : 'best',
    window: params.get('window') === 'week' ? 'week' : params.get('window') === 'month' ? 'month' : 'all',
    cursor: params.get('cursor') ?? undefined };
  const module = visit.includes('ranking-module');
  const held = samples.find(sample => module ? sample.path.includes('/rankings?') : sample === thread);
  if (loading && !held) throw new Error(`Ranking loading visit has no content request: ${persona}/${visit}`);
  const playback = recordedFetch(record, persona, samples.map(sample => ({ label: sample.label,
    state: loading && sample === held ? 'loading' : sample.status >= 400 ? 'error' : 'populated',
  })), { pathPrefix: BFF_PREFIX, sequence: true });
  const misses: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try { return await playback.fetcher(input, init); }
    catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        misses.push(String(error));
        onMismatch?.(error);
      }
      throw error;
    }
  }) as typeof fetch;
  const assertMatched = () => { if (misses.length) throw new Error(misses.join('\n')); };
  return { samples, query, ref, fetcher, dispose: playback.dispose, assertMatched,
    async read(locale: UiLocale) {
      const page = await rankingVisit({ replay: rankingVisitHost(fetcher, persona !== 'visitor'), ref, locale, query,
        ...(module ? { module: rankingChart } : {}) });
      assertMatched();
      return page;
    },
  };
}

/** The component owns transport lifetime; the production visit owns every read and frame. */
export function RecordedRankingPage({ record, persona, visit, loading = false, locale = 'en' }: {
  record: AnswerRecord; persona: AnswerPersona; visit: string; loading?: boolean; locale?: UiLocale;
}) {
  const [page, setPage] = useState<ReactNode>(null);
  const [failure, setFailure] = useState<unknown>(null);
  useEffect(() => {
    let active = true;
    setPage(null);
    setFailure(null);
    const transport = rankingRecording(record, persona, visit, loading, locale,
      error => { if (active) setFailure(error); });
    void transport.read(locale).then(result => { if (active) setPage(result); }, error => { if (active) setFailure(error); });
    return () => { active = false; transport.dispose(); };
  }, [record, persona, visit, loading, locale]);
  if (failure) throw failure;
  return page ?? <RankingSkeleton />;
}
