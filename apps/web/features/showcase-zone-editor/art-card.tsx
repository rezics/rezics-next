'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { ChoiceSelect } from '@rezics/ui/select';
import { PlusIcon } from 'lucide-react';
import { useId } from 'react';
import { type ImageDraft, type LogoAnchor, logoAnchors, type LogoTone, type SavedImage } from '../showcase-editor/art.ts';
import { AdultChoice, DropArea, LayerSwatch, Panel, SlotButtons } from '../showcase-editor/art-parts.tsx';
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

export interface ArtCardActions {
  onFile: (file: File) => void;
  onRemove: () => void;
  onDiscard: () => void;
  onAdd: () => void;
  /** The author's own call on an image about to be uploaded. */
  onAdult: (adult: boolean) => void;
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
      <LayerSwatch url={draft.source.url} tone={tone} />
      {onAnchor && slotAnchor ? <AnchorSelect value={slotAnchor} onChange={onAnchor} disabled={busy} e={e} /> : null}
    </div> : saved && url ? <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      {background ? <img src={url} alt="" className="max-h-48 w-full rounded-xl bg-muted object-contain sm:w-72" />
        : <LayerSwatch url={url} tone={tone} />}
      {onAnchor && anchor ? <AnchorSelect value={anchor} onChange={onAnchor} disabled={busy} e={e} /> : null}
    </div> : missing ? <p className="rounded-lg bg-muted px-3 py-2 text-pretty text-muted-foreground text-sm">{t.imageUnavailable}</p>
      : <DropArea onFile={actions.onFile} disabled={busy} accept={accept} label={e.chooseImage} types={types} compact />}
    {note && !draft && !has ? <p className="rounded-lg bg-muted px-3 py-2 text-pretty text-muted-foreground text-sm">{note}</p> : null}
    {draft?.source.file ? <AdultChoice adult={Boolean(draft.adult)} disabled={busy} onChange={actions.onAdult} t={e} /> : null}
    <SlotStatusView status={status} t={e} />
    {draft || has ? <SlotButtons has onFile={actions.onFile} onRemove={actions.onRemove} onDiscard={actions.onDiscard} accept={accept}
      canRemove={has && !draft} pending={Boolean(draft)} busy={busy} t={e}
      commit={<Button type="button" size="sm" disabled={busy || !canAdd} isLoading={busy} onClick={actions.onAdd}>
        {!busy ? <PlusIcon aria-hidden="true" /> : null}{busy ? t.slotAdding : t.slotAdd}</Button>} /> : null}
  </Panel>;
}

function AnchorSelect({ value, onChange, disabled, e }: { value: LogoAnchor; onChange: (anchor: LogoAnchor) => void; disabled: boolean; e: EditorCopy }) {
  return <label className="grid flex-1 gap-1 text-sm">
    <span className="font-medium">{e.logoAnchor}</span>
    <ChoiceSelect label={e.logoAnchor} value={value} disabled={disabled} onValueChange={next => next && onChange(next as LogoAnchor)}
      options={logoAnchors.map(option => ({ value: option, label: anchorLabel(option, e) }))} />
  </label>;
}
