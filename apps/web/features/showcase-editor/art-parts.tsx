'use client';

import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { cn } from '@rezics/ui/utils';
import { ImageUpIcon, Trash2Icon, Undo2Icon } from 'lucide-react';
import { type DragEvent, type ReactNode, useId, useRef, useState } from 'react';
import type { LogoTone } from './art.ts';
import type { EditorCopy } from './messages.ts';

// The parts both art editors are made of, the Work's (one slot saved at a time) and the Realm's
// (slot art added to a slide): a file picker, a drop area, a titled panel, a swatch for logos and
// cutouts, the buttons under a slot and the adult-content choice for an image about to be uploaded.

/** A visually plain file chooser: the button is the control; the native input only opens the picker. */
export function FilePicker({ accept, label, onFile, disabled, variant = 'outline' }: {
  accept: readonly string[]; label: string; onFile: (file: File) => void; disabled?: boolean; variant?: 'outline' | 'default';
}) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <input ref={input} type="file" hidden accept={accept.join(',')}
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onFile(file); }} />
    <Button type="button" variant={variant} size="sm" disabled={disabled} onClick={() => input.current?.click()}>
      <ImageUpIcon aria-hidden="true" />{label}</Button>
  </>;
}

/** An empty slot: drop an image anywhere on it, or choose one. */
export function DropArea({ onFile, disabled, accept, label, types, compact }: {
  onFile: (file: File) => void; disabled: boolean; accept: readonly string[]; label: string; types: string; compact?: boolean;
}) {
  const [over, setOver] = useState(false);
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (file && !disabled) onFile(file);
  };
  return <div onDragOver={event => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
    className={cn('grid place-content-center justify-items-center gap-3 rounded-xl border-2 border-dashed p-5 text-center',
      compact ? 'min-h-32' : 'min-h-40', over ? 'border-primary bg-primary/5' : 'border-border')}>
    <FilePicker accept={accept} label={label} onFile={onFile} disabled={disabled} variant="default" />
    <span className="text-muted-foreground text-xs">{types}</span>
  </div>;
}

export function Panel({ title, help, badge, children, labelledBy, level = 4 }: { title: string; help?: ReactNode; badge?: ReactNode;
  children: ReactNode; labelledBy: string; level?: 3 | 4 | 5 }) {
  const Heading = `h${level}` as const;
  return <section aria-labelledby={labelledBy} className="grid gap-4 rounded-2xl border border-border/70 bg-card p-4 sm:p-5">
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Heading id={labelledBy} className={level === 3 ? 'font-semibold text-lg' : 'font-semibold'}>{title}</Heading>
        {badge}
      </div>
      {help ? <p className="text-pretty text-muted-foreground text-sm">{help}</p> : null}
    </div>
    {children}
  </section>;
}

/** How a logo or cutout looks against what it will sit on: light logos on the dark scrim, dark ones on light. */
export function LayerSwatch({ url, tone, faded }: { url: string; tone: LogoTone | null; faded?: boolean }) {
  // A flex box of definite height, so the image's percentage limits resolve and a tall cutout fits whole.
  return <div className={cn('flex h-24 w-full items-center justify-center overflow-hidden rounded-xl p-3 sm:w-40', faded && 'opacity-40',
    tone === 'light' ? 'bg-[#101b2c]' : tone === 'dark' ? 'bg-[#eef2f7]'
      : 'bg-[repeating-conic-gradient(#8883_0_25%,transparent_0_50%)] bg-size-[16px_16px]')}>
    <img src={url} alt="" className="max-h-full max-w-full object-contain" />
  </div>;
}

/**
 * The buttons under a slot: choose or replace, remove, and, with a change pending, discard and the
 * slot's own commit (`commit` is Save for the Work's art, Add to slide for a slide's).
 */
export function SlotButtons({ has, canRemove, pending, busy, accept, chooseLabel, onFile, onRemove, onDiscard, commit, t }: {
  has: boolean; canRemove: boolean; pending: boolean; busy: boolean; accept: readonly string[]; chooseLabel?: string;
  onFile: (file: File) => void; onRemove: () => void; onDiscard: () => void; commit: ReactNode; t: EditorCopy;
}) {
  return <div className="flex flex-wrap items-center justify-between gap-2">
    <div className="flex flex-wrap gap-2">
      <FilePicker accept={accept} label={has ? t.replaceImage : chooseLabel ?? t.chooseImage} onFile={onFile} disabled={busy}
        variant={has ? 'outline' : 'default'} />
      {canRemove ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
        <Trash2Icon aria-hidden="true" />{t.remove}</Button> : null}
    </div>
    {pending ? <div className="flex flex-wrap gap-2">
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onDiscard}><Undo2Icon aria-hidden="true" />{t.discard}</Button>
      {commit}
    </div> : null}
  </div>;
}

/**
 * Whether the author calls the image they are about to upload adult content. Left unmarked, the
 * check on the author's own device decides; marked, readers who have not chosen to see adult
 * images get a hidden-image icon in its place, however that check goes.
 */
export function AdultChoice({ adult, disabled, onChange, t }: { adult: boolean; disabled: boolean; onChange: (adult: boolean) => void; t: EditorCopy }) {
  const id = useId();
  return <div className="grid gap-1.5 rounded-lg bg-muted px-3 py-2.5 text-sm">
    <Checkbox checked={adult} disabled={disabled} aria-describedby={`${id}-help`}
      onCheckedChange={({ checked }) => onChange(checked === true)}>{t.adultLabel}</Checkbox>
    <p id={`${id}-help`} className="text-pretty text-muted-foreground text-xs">{adult ? t.adultMarked : t.adultUnmarked}</p>
  </div>;
}
