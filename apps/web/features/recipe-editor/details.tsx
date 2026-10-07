'use client';

import { Input } from '@rezics/ui/input';
import { Textarea } from '@rezics/ui/textarea';
import { type RefObject, useRef } from 'react';
import { useSnapshot } from './controls.tsx';
import type { Copy } from './messages.ts';
import { type DetailsSaver, entryOf, type NotesWriter } from './saves.ts';
import { directionOf } from '../studio/types.ts';

/** Title and description share one header record, so leaving either writes both as they are typed. */
export function DetailsSection({ details, notes, notesField, language, t }: { details: DetailsSaver; notes: NotesWriter;
  notesField: RefObject<HTMLTextAreaElement | null>; language: string; t: Copy }) {
  const saved = useSnapshot(details);
  const written = useSnapshot(notes);
  const title = useRef<HTMLInputElement>(null);
  const description = useRef<HTMLTextAreaElement>(null);
  const current = entryOf(saved.values, language);
  const commit = () => {
    const next = { title: title.current?.value.trim() ?? current.title, description: description.current?.value.trim() ?? current.description };
    if (!next.title) { if (title.current) title.current.value = current.title; return; }
    void details.submit(next);
  };
  const lang = { lang: language, dir: directionOf(language) } as const;
  return <section aria-labelledby="recipe-details" className="grid gap-4">
    <h2 id="recipe-details" className="font-semibold text-xl">{t.detailsHeading}</h2>
    <label className="grid gap-1 text-sm"><span className="font-medium">{t.title}</span>
      <Input key={`title:${current.title}`} ref={title} defaultValue={current.title} maxLength={200} autoComplete="off" size="lg"
        className="font-work-title text-lg" onBlur={commit} {...lang}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} /></label>
    <label className="grid gap-1 text-sm"><span className="font-medium">{t.description}</span>
      <Textarea key={`description:${current.description}`} ref={description} defaultValue={current.description} onBlur={commit}
        maxLength={5000} className="min-h-20" {...lang} />
      <span className="text-muted-foreground text-xs">{t.descriptionHelp}</span></label>
    <label className="grid gap-1 text-sm"><span className="font-medium">{t.notes}</span>
      <Textarea key={`notes:${written.notes.body}`} ref={notesField} defaultValue={written.notes.body} maxLength={20000} className="min-h-28" {...lang}
        onBlur={event => void notes.save(event.currentTarget.value.trim())} />
      <span className="text-muted-foreground text-xs">{t.notesHelp}</span></label>
  </section>;
}
