'use client';

import { type RefObject, useRef } from 'react';
import { SyncedInput, SyncedTextarea, useSnapshot } from './controls.tsx';
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
    <div className="grid gap-1 text-sm"><label htmlFor="recipe-title" className="font-medium">{t.title}</label>
      <SyncedInput id="recipe-title" ref={title} value={current.title} maxLength={200} autoComplete="off" size="lg"
        className="font-work-title text-lg" onBlur={commit} {...lang}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} /></div>
    <div className="grid gap-1 text-sm"><label htmlFor="recipe-description" className="font-medium">{t.description}</label>
      <SyncedTextarea id="recipe-description" ref={description} value={current.description}
        onBlur={commit} maxLength={5000} className="min-h-20" aria-describedby="recipe-description-help" {...lang} />
      <span id="recipe-description-help" className="text-muted-foreground text-xs">{t.descriptionHelp}</span></div>
    <div className="grid gap-1 text-sm"><label htmlFor="recipe-notes" className="font-medium">{t.notes}</label>
      <SyncedTextarea id="recipe-notes" ref={notesField} value={written.notes.body} maxLength={20000}
        className="min-h-28" aria-describedby="recipe-notes-help" {...lang}
        onBlur={event => void notes.save(event.currentTarget.value.trim())} />
      <span id="recipe-notes-help" className="text-muted-foreground text-xs">{t.notesHelp}</span></div>
  </section>;
}
