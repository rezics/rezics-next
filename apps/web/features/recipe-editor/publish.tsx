'use client';

import { Badge } from '@rezics/ui/badge';
import { Button, buttonVariants } from '@rezics/ui/button';
import { CircleCheckIcon, ExternalLinkIcon, SendIcon } from 'lucide-react';
import Link from '../shell/localized-link.tsx';
import type { Copy } from './messages.ts';
import type { NotesSnapshot } from './saves.ts';

/** What a recipe still lacks before it can be read by everyone. */
export function missingBeforePublishing({ title, ingredients, steps, notes }: { title: string; ingredients: number; steps: number; notes: string }) {
  return { title: !title.trim(), ingredients: ingredients === 0, steps: steps === 0, notes: !notes.trim() };
}

/**
 * The state of the recipe and the one action that changes it: publish, or publish what changed since.
 * It stays enabled while a field's save is in flight: leaving the notes field to click it starts that
 * save, and the publish waits for it.
 */
export function PublishBar({ snapshot, missing, onPublish, workHref, t }: {
  snapshot: NotesSnapshot; missing: ReturnType<typeof missingBeforePublishing>; onPublish: () => void; workHref: string; t: Copy;
}) {
  const needs = [missing.title ? t.needTitle : null, missing.ingredients ? t.needIngredient : null,
    missing.steps ? t.needStep : null, missing.notes ? t.needNotes : null].filter((item): item is string => item !== null);
  const blocked = needs.length > 0;
  return <div className="flex flex-wrap items-center gap-2">
    {snapshot.published ? <Badge variant="success"><CircleCheckIcon aria-hidden="true" />{t.statePublished}</Badge>
      : <Badge variant="outline">{t.stateDraft}</Badge>}
    <Button type="button" onClick={onPublish} disabled={blocked || snapshot.publishing}
      aria-describedby={blocked ? 'publish-needs' : undefined} className="pointer-coarse:h-11">
      <SendIcon aria-hidden="true" />{snapshot.publishing ? t.publishing : snapshot.published ? t.publishUpdate : t.publish}</Button>
    {snapshot.published ? <Link href={workHref} className={buttonVariants({ variant: 'outline', className: 'pointer-coarse:h-11' })}>
      {t.viewRecipe}<ExternalLinkIcon aria-hidden="true" /></Link> : null}
    {blocked ? <p id="publish-needs" className="basis-full text-muted-foreground text-xs">{t.publishNeeds} {needs.join(', ')}.</p> : null}
  </div>;
}
