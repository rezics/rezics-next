'use client';

import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { browserMainApi } from '../api/browser.ts';
import { communityText as words } from './messages.ts';

export interface TopicChoice { id: string; label: string }

/** Global Concept search: suggestions carry identity, while chips keep the chosen labels visible. */
export function TopicPicker({ locale, value, onChange, max = 3 }: { locale: UiLocale;
  value: TopicChoice[]; onChange: (topics: TopicChoice[]) => void; max?: number }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TopicChoice[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'failed' | 'ready'>('idle');
  useEffect(() => {
    if (!query.trim() || value.length >= max) { setResults([]); setState('idle'); return; }
    let current = true;
    const timer = window.setTimeout(() => { void (async () => {
      setState('loading');
      try {
        const { data, error } = await browserMainApi().v1.concepts.get({
          query: { q: query.trim(), language: locale === 'zh-Hans' ? 'zh-CN' : 'en', limit: 10 },
        });
        if (!current) return;
        if (error || !data) { setState('failed'); return; }
        setResults(data.items.filter(item => !value.some(selected => selected.id === item.concept))
          .map(item => ({ id: item.concept, label: item.label })));
        setState('ready');
      } catch { if (current) setState('failed'); }
    })(); }, 250);
    return () => { current = false; window.clearTimeout(timer); };
  }, [query, locale, max, value]);
  return <div className="grid min-w-0 gap-2">
    {value.length ? <ul className="flex flex-wrap gap-2">{value.map(topic => <li key={topic.id}>
      <Button type="button" size="sm" variant="outline" pill
        aria-label={`${words.topicRemove[locale]}: ${topic.label}`}
        onClick={() => onChange(value.filter(item => item.id !== topic.id))}>
        {topic.label}<XIcon aria-hidden="true" className="size-3.5" /></Button>
    </li>)}</ul> : null}
    {value.length < max ? <>
      <Input type="search" value={query} onChange={event => setQuery(event.currentTarget.value)}
        placeholder={words.topicSearch[locale]} aria-label={words.topicSearch[locale]} maxLength={120}
        autoComplete="off" />
      {state === 'failed' ? <p role="status" className="text-destructive-foreground text-sm">
        {words.topicUnavailable[locale]}</p> : null}
      {state === 'ready' && query.trim() ? results.length ? <ul className="grid max-h-52 gap-1 overflow-auto
        rounded-xl border border-border bg-card p-1 shadow-sm">{results.map(topic => <li key={topic.id}>
        <button type="button" onClick={() => { onChange([...value, topic]); setQuery(''); }}
          className="w-full rounded-lg px-3 py-2 text-start text-sm outline-none hover:bg-accent
            focus-visible:ring-2 focus-visible:ring-ring">{topic.label}</button>
      </li>)}</ul> : <p className="text-muted-foreground text-sm">{words.topicNone[locale]}</p> : null}
    </> : null}
  </div>;
}

export function DirectoryTopicFilter({ locale, q, sort, selected }: { locale: UiLocale;
  q: string; sort: string; selected: TopicChoice | null }) {
  const [topics, setTopics] = useState<TopicChoice[]>(selected ? [selected] : []);
  return <form action={localizedPath('/r', locale)} className="grid gap-2 rounded-2xl border border-border/80
    bg-card p-4 sm:max-w-md">
    <label className="text-sm font-semibold">{words.topics[locale]}</label>
    <TopicPicker locale={locale} value={topics} onChange={setTopics} max={1} />
    {q ? <input type="hidden" name="q" value={q} /> : null}
    {sort !== 'activity' ? <input type="hidden" name="sort" value={sort} /> : null}
    {topics[0] ? <input type="hidden" name="topic" value={topics[0].id} /> : null}
    <Button type="submit" size="sm" variant="outline" className="justify-self-start">
      {words.topicApply[locale]}</Button>
  </form>;
}
