'use client';

import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { XIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import { typeaheadPrefix } from '../search/typeahead.tsx';
import type { Copy } from './messages.ts';
import { workIdFrom } from './route.ts';

export interface WorkChoice { id: string; title: string; language: string }
export type WorkLoader = (prefix: string, locale: UiLocale) => Promise<WorkChoice[]>;

const searchWorks: WorkLoader = async (prefix, locale) => {
  const { data } = await browserMainApi().v1.search.typeahead.get({ query: { prefix, language: locale } });
  return (data?.items ?? []).map(item => ({ id: item.work.slice(-36), title: item.title.value, language: item.title.language }));
};

/**
 * Names another Work for a form: search by title, or paste its address or ID. The form receives
 * the Work's ID in a field called `name`; a title search only suggests, and an address or ID is
 * accepted as it stands, since only an ID is a Work's identity.
 */
export function WorkPicker({ name, locale, t, initial = '', load = searchWorks, invalid, label, onChange }: {
  name: string; locale: UiLocale; t: Copy; initial?: string; load?: WorkLoader; invalid?: boolean;
  /** The accessible name, for a picker outside a Field whose label names it. */
  label?: string;
  /** The Work the person named, or null when none is named now: for a picker that is not in a form. */
  onChange?: (work: { id: string; title: string | null } | null) => void;
}) {
  const listId = useId();
  const [text, setText] = useState(initial);
  const [chosen, setChosen] = useState<WorkChoice | null>(null);
  const [items, setItems] = useState<readonly WorkChoice[]>([]);
  const asked = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function type(value: string) {
    setText(value);
    setChosen(null);
    const named = workIdFrom(value);
    onChange?.(named ? { id: named, title: null } : null);
    clearTimeout(timer.current);
    const prefix = workIdFrom(value) ? null : typeaheadPrefix(value);
    const request = ++asked.current;
    if (!prefix) { setItems([]); return; }
    timer.current = setTimeout(() => {
      load(prefix, locale).then(found => { if (request === asked.current) setItems(found); },
        () => { if (request === asked.current) setItems([]); });
    }, 200);
  }
  const value = chosen?.id ?? workIdFrom(text) ?? '';
  return <div data-field={name} className="grid gap-2">
    <input type="hidden" name={name} value={value} />
    {chosen ? <div className="flex items-center justify-between gap-2 rounded-xl border border-border/80 bg-primary/5 px-3 py-2 text-sm">
      <span lang={chosen.language} className="min-w-0 break-words">{t.pickerChosen({ title: chosen.title })}</span>
      <Button type="button" variant="ghost" size="sm" aria-label={t.pickerClear} onClick={() => { setChosen(null); setText(''); setItems([]); onChange?.(null); }}>
        <XIcon aria-hidden="true" /></Button>
    </div> : <Input aria-label={label} value={text} onChange={event => type(event.currentTarget.value)} autoComplete="off" spellCheck={false}
      aria-invalid={invalid || undefined} aria-controls={items.length ? listId : undefined} />}
    {!chosen && items.length ? <ul id={listId} aria-label={t.pickerSuggestions} className="grid gap-1">
      {items.map(item => <li key={item.id}><button type="button" lang={item.language}
        onClick={() => { setChosen(item); setItems([]); onChange?.({ id: item.id, title: item.title }); }}
        className="w-full rounded-xl px-3 py-2 text-start text-sm hover:bg-accent focus-visible:bg-accent">{item.title}</button></li>)}
    </ul> : null}
    <span role="status" className="sr-only">{!chosen && items.length ? t.pickerFound(items.length) : ''}</span>
  </div>;
}
