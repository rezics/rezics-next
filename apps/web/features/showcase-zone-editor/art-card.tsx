'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { ChoiceSelect } from '@rezics/ui/select';
import { cn } from '@rezics/ui/utils';
import { ImageUpIcon, PlusIcon, Trash2Icon, Undo2Icon } from 'lucide-react';
import { type DragEvent, type ReactNode, useId, useRef, useState } from 'react';
import { type ImageDraft, type LogoAnchor, logoAnchors, type LogoTone, type SavedImage } from '../showcase-editor/art.ts';
import { anchorLabel } from '../showcase-editor/cards.tsx';
import { FrameEditor } from '../showcase-editor/frame-editor.tsx';
import type { BackgroundRole, PixelRect } from '../showcase-editor/frame.ts';
import { acceptedTypes } from '../showcase-editor/image-file.ts';
import type { EditorCopy } from '../showcase-editor/messages.ts';
import { type SlotStatus, SlotStatusView } from '../showcase-editor/status.tsx';
import type { ZoneEditorCopy } from './messages.ts';

// One art slot of a slide: a background, a logo or the cutout. The frame editor and the status
// lines are the Work art editor's; the rest differs because a slide's art is added to the slide
// (and saved with the whole showcase) instead of being saved slot by slot.

function FilePicker({ accept, label, onFile, disabled, variant = 'outline' }: {
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
function DropArea({ onFile, disabled, accept, label, types }: {
  onFile: (file: File) => void; disabled: boolean; accept: readonly string[]; label: string; types: string;
}) {
  const [over, setOver] = useState(false);
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (file && !disabled) onFile(file);
  };
  return <div onDragOver={event => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
    className={cn('grid min-h-32 place-content-center justify-items-center gap-3 rounded-xl border-2 border-dashed p-5 text-center',
      over ? 'border-primary bg-primary/5' : 'border-border')}>
    <FilePicker accept={accept} label={label} onFile={onFile} disabled={disabled} variant="default" />
    <span className="text-muted-foreground text-xs">{types}</span>
  </div>;
}

/** How a logo or cutout looks against what it will sit on: light logos on the dark scrim, dark ones on light. */
function Swatch({ url, tone, faded }: { url: string; tone: LogoTone | null; faded?: boolean }) {
  return <div className={cn('flex h-24 w-full items-center justify-center overflow-hidden rounded-xl p-3 sm:w-40', faded && 'opacity-40',
    tone === 'light' ? 'bg-[#101b2c]' : tone === 'dark' ? 'bg-[#eef2f7]' : 'bg-[repeating-conic-gradient(#8883_0_25%,transparent_0_50%)] bg-size-[16px_16px]')}>
    <img src={url} alt="" className="max-h-full max-w-full object-contain" />
  </div>;
}

function Panel({ title, help, badge, children, labelledBy, level = 4 }: { title: string; help?: ReactNode; badge?: ReactNode;
  children: ReactNode; labelledBy: string; level?: 3 | 4 | 5 }) {
  const Heading = `h${level}` as const;
  return <section aria-labelledby={labelledBy} className="grid gap-4 rounded-2xl border border-border/70 bg-card p-4 sm:p-5">
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Heading id={labelledBy} className="font-semibold">{title}</Heading>
        {badge}
      </div>
      {help ? <p className="text-pretty text-muted-foreground text-sm">{help}</p> : null}
    </div>
    {children}
  </section>;
}

export interface ArtCardActions {
  onFile: (file: File) => void;
  onRemove: () => void;
  onDiscard: () => void;
  onAdd: () => void;
}

/**
 * A slot of one slide. `saved` is the image the slide uses now; `missing` marks a slide that names
 * an image Main cannot deliver; `draft` is a file chosen and not yet added. `canAdd` is false while
 * the Zone has no Realm to hold campaign art.
 */
export function ArtCard({ role, title, help, level, tone, saved, missing, draft, status, busy, canAdd, anchor, onAnchor, note,
  showPhone, framedUrl, onFrame, actions, t, e }: {
  role: BackgroundRole | 'layer'; title: string; help?: string; level?: 3 | 4 | 5; tone: LogoTone | null;
  saved: SavedImage | undefined; missing: boolean; draft: ImageDraft | undefined; status: SlotStatus | undefined;
  busy: boolean; canAdd: boolean; anchor: LogoAnchor | null; onAnchor?: (anchor: LogoAnchor) => void;
  /** What readers see while this slot is empty. */
  note?: string | null; showPhone?: boolean;
  /** A saved background drawn at its frame, when Main has no renditions for it yet. */
  framedUrl?: string;
  onFrame?: (next: { frame: PixelRect; focal: PixelRect | null }) => void;
  actions: ArtCardActions; t: ZoneEditorCopy; e: EditorCopy;
}) {
  const id = useId();
  const background = role !== 'layer';
  const has = Boolean(saved) || missing;
  const url = saved ? saved.candidates.at(-1)?.url ?? framedUrl ?? saved.url : undefined;
  const badge = draft ? <Badge variant="warning" size="sm">{t.slotNotAdded}</Badge>
    : has ? <Badge variant="success" size="sm">{t.slotOnSlide}</Badge> : <Badge variant="outline" size="sm">{e.notSet}</Badge>;
  const accept = background ? acceptedTypes.background : acceptedTypes.layer;
  const types = background ? e.backgroundTypes : e.layerTypes;
  const slotAnchor = draft ? draft.anchor : anchor;
  return <Panel labelledBy={`${id}-title`} title={title} help={help} level={level} badge={badge}>
    {draft ? background && draft.frame && onFrame ? <>
      <FrameEditor src={draft.source.url} size={draft.source.size} role={role} frame={draft.frame} focal={draft.focal} onChange={onFrame}
        showPhone={Boolean(showPhone)} t={e} disabled={busy} />
      <p className="text-muted-foreground text-xs">{e.focalHelp}</p>
    </> : <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <Swatch url={draft.source.url} tone={tone} />
      {onAnchor && slotAnchor ? <AnchorSelect value={slotAnchor} onChange={onAnchor} disabled={busy} e={e} /> : null}
    </div> : saved && url ? <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      {background ? <img src={url} alt="" className="max-h-48 w-full rounded-xl bg-muted object-contain sm:w-72" />
        : <Swatch url={url} tone={tone} />}
      {onAnchor && anchor ? <AnchorSelect value={anchor} onChange={onAnchor} disabled={busy} e={e} /> : null}
    </div> : missing ? <p className="rounded-lg bg-muted px-3 py-2 text-pretty text-muted-foreground text-sm">{t.imageUnavailable}</p>
      : <DropArea onFile={actions.onFile} disabled={busy} accept={accept} label={e.chooseImage} types={types} />}
    {note && !draft && !has ? <p className="rounded-lg bg-muted px-3 py-2 text-pretty text-muted-foreground text-sm">{note}</p> : null}
    <SlotStatusView status={status} t={e} />
    {draft || has ? <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap gap-2">
        <FilePicker accept={accept} label={e.replaceImage} onFile={actions.onFile} disabled={busy} />
        {has && !draft ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={actions.onRemove}>
          <Trash2Icon aria-hidden="true" />{e.remove}</Button> : null}
      </div>
      {draft ? <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={actions.onDiscard}><Undo2Icon aria-hidden="true" />{e.discard}</Button>
        <Button type="button" size="sm" disabled={busy || !canAdd} isLoading={busy} onClick={actions.onAdd}>
          {!busy ? <PlusIcon aria-hidden="true" /> : null}{busy ? t.slotAdding : t.slotAdd}</Button>
      </div> : null}
    </div> : null}
  </Panel>;
}

function AnchorSelect({ value, onChange, disabled, e }: { value: LogoAnchor; onChange: (anchor: LogoAnchor) => void; disabled: boolean; e: EditorCopy }) {
  return <label className="grid flex-1 gap-1 text-sm">
    <span className="font-medium">{e.logoAnchor}</span>
    <ChoiceSelect label={e.logoAnchor} value={value} disabled={disabled} onValueChange={next => next && onChange(next as LogoAnchor)}
      options={logoAnchors.map(option => ({ value: option, label: anchorLabel(option, e) }))} />
  </label>;
}
