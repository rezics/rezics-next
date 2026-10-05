'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { ChoiceSelect } from '@rezics/ui/select';
import { SegmentGroup, SegmentGroupItem, SegmentGroupItemText } from '@rezics/ui/segment-group';
import { cn } from '@rezics/ui/utils';
import { ImageUpIcon, PlayIcon, Trash2Icon, Undo2Icon } from 'lucide-react';
import { type DragEvent, type ReactNode, useId, useRef, useState } from 'react';
import { uiLocales } from '../../i18n/define.ts';
import {
  canonicalTag, type Draft, type LogoAnchor, logoAnchors, type LogoTone, logoTones, NEUTRAL_LANGUAGE, type SavedImage,
} from './art.ts';
import { FrameEditor } from './frame-editor.tsx';
import type { BackgroundRole, PixelRect } from './frame.ts';
import { acceptedTypes } from './image-file.ts';
import { languageName } from './language.ts';
import type { EditorCopy } from './messages.ts';
import { type SlotStatus, SlotStatusView } from './status.tsx';
import { trailerOpening, trailerProblem } from './trailer.ts';

export const anchorLabel = (anchor: LogoAnchor, t: EditorCopy) => ({ 'start-bottom': t.anchorStartBottom,
  'center-top': t.anchorCenterTop, 'center-middle': t.anchorCenterMiddle, 'center-bottom': t.anchorCenterBottom })[anchor];
export const toneLabel = (tone: LogoTone, t: EditorCopy) => tone === 'light' ? t.toneLight : t.toneDark;

/** A visually plain file chooser: the button is the control; the native input only opens the picker. */
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

/** What a slot holds against what is saved, as one short label. */
function SlotBadge({ saved, draft, t }: { saved: boolean; draft: (Draft | { kind: 'trailer'; savedAs?: string }) | undefined; t: EditorCopy }) {
  // A change Main has recorded is saved, though the page has not read it back yet.
  if (draft?.savedAs) return <Badge variant="success" size="sm">{t.saved}</Badge>;
  if (draft?.kind === 'remove') return <Badge variant="destructive" size="sm">{t.willRemove}</Badge>;
  if (draft) return <Badge variant="warning" size="sm">{t.unsaved}</Badge>;
  return saved ? <Badge variant="success" size="sm">{t.saved}</Badge> : <Badge variant="outline" size="sm">{t.notSet}</Badge>;
}

export interface SlotActions {
  onFile: (file: File) => void;
  onRemove: () => void;
  onDiscard: () => void;
  onSave: () => void;
  onReload: () => void;
}

/** The buttons under a slot: choose or replace, remove, and, with a change pending, discard and save. */
function SlotFooter({ has, draft, busy, accept, actions, t, chooseLabel }: {
  has: boolean; draft: Draft | undefined; busy: boolean; accept: readonly string[]; actions: SlotActions; t: EditorCopy; chooseLabel?: string;
}) {
  return <div className="flex flex-wrap items-center justify-between gap-2">
    <div className="flex flex-wrap gap-2">
      <FilePicker accept={accept} label={has ? t.replaceImage : chooseLabel ?? t.chooseImage} onFile={actions.onFile} disabled={busy}
        variant={has ? 'outline' : 'default'} />
      {has && draft?.kind !== 'remove' ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={actions.onRemove}>
        <Trash2Icon aria-hidden="true" />{t.remove}</Button> : null}
    </div>
    {draft && !draft.savedAs ? <div className="flex flex-wrap gap-2">
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={actions.onDiscard}><Undo2Icon aria-hidden="true" />{t.discard}</Button>
      <Button type="button" size="sm" disabled={busy} isLoading={busy} onClick={actions.onSave}>{busy ? t.saving : t.save}</Button>
    </div> : null}
  </div>;
}

function Panel({ title, help, badge, children, labelledBy, level = 4 }: { title: string; help?: ReactNode; badge?: ReactNode;
  children: ReactNode; labelledBy: string; level?: 3 | 4 }) {
  const Heading = level === 3 ? 'h3' : 'h4';
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
    className={cn('grid min-h-40 place-content-center justify-items-center gap-3 rounded-xl border-2 border-dashed p-5 text-center',
      over ? 'border-primary bg-primary/5' : 'border-border')}>
    <FilePicker accept={accept} label={label} onFile={onFile} disabled={disabled} variant="default" />
    <span className="text-muted-foreground text-xs">{types}</span>
  </div>;
}

export function BackgroundCard({ role, saved, draft, status, busy, note, showPhone, actions, onFrame, t }: {
  role: BackgroundRole; saved: SavedImage | undefined; draft: Draft | undefined; status: SlotStatus | undefined; busy: boolean;
  /** What readers see while this slot is empty. */
  note: string | null; showPhone: boolean; actions: SlotActions;
  onFrame: (next: { frame: PixelRect; focal: PixelRect | null }) => void; t: EditorCopy;
}) {
  const id = useId();
  const landscape = role === 'background-landscape';
  const editing = draft?.kind === 'image' ? draft : null;
  const source = editing ? editing.source : saved && draft?.kind !== 'remove' ? { url: saved.url, size: saved.size } : null;
  const frame = editing ? editing.frame : saved?.frame;
  const focal = editing ? editing.focal : saved?.focal ?? null;
  return <Panel labelledBy={`${id}-title`} title={landscape ? t.landscapeTitle : t.portraitTitle}
    help={landscape ? t.landscapeHelp : t.portraitHelp} badge={<SlotBadge saved={Boolean(saved)} draft={draft} t={t} />}>
    {source && frame ? <>
      <FrameEditor src={source.url} size={source.size} role={role} frame={frame} focal={focal} onChange={onFrame}
        showPhone={showPhone} t={t} disabled={busy} />
      <p className="text-muted-foreground text-xs">{t.focalHelp}</p>
    </> : draft?.kind === 'remove' && saved ? <div className="relative overflow-hidden rounded-xl">
      <img src={saved.url} alt="" className="max-h-48 w-full object-contain opacity-40" />
    </div> : <DropArea onFile={actions.onFile} disabled={busy} accept={acceptedTypes.background} label={t.chooseImage}
      types={t.backgroundTypes} />}
    {note ? <p className="rounded-lg bg-muted px-3 py-2 text-pretty text-muted-foreground text-sm">{note}</p> : null}
    <SlotStatusView status={status} t={t} onReload={actions.onReload} />
    {source || draft ? <SlotFooter has={Boolean(source) || draft?.kind === 'remove'} draft={draft} busy={busy}
      accept={acceptedTypes.background} actions={actions} t={t} /> : null}
  </Panel>;
}

/** How a logo or cutout looks against what it will sit on: light logos on the dark scrim, dark ones on light. */
function LayerSwatch({ url, tone }: { url: string; tone: LogoTone | null }) {
  return <div className={cn('grid h-24 w-full place-items-center overflow-hidden rounded-xl p-3 sm:w-40',
    tone === 'light' ? 'bg-[#101b2c]' : tone === 'dark' ? 'bg-[#eef2f7]'
      : 'bg-[repeating-conic-gradient(#8883_0_25%,transparent_0_50%)] bg-size-[16px_16px]')}>
    <img src={url} alt="" className="max-h-full max-w-full object-contain" />
  </div>;
}

/** A logo key or the cutout: the image on its backdrop, the logo's position, and the slot's actions. */
export function LayerRow({ title, help, tone, saved, draft, status, busy, anchor, onAnchor, actions, t, level }: {
  title: string; help?: string; level?: 3 | 4; tone: LogoTone | null; saved: SavedImage | undefined; draft: Draft | undefined;
  status: SlotStatus | undefined; busy: boolean; anchor: LogoAnchor | null; onAnchor?: (anchor: LogoAnchor) => void;
  actions: SlotActions; t: EditorCopy;
}) {
  const id = useId();
  const url = draft?.kind === 'image' ? draft.source.url : saved?.candidates.at(-1)?.url ?? saved?.url;
  return <Panel labelledBy={`${id}-title`} title={title} help={help} level={level}
    badge={<SlotBadge saved={Boolean(saved)} draft={draft} t={t} />}>
    {url ? <div className={cn('flex flex-col gap-4 sm:flex-row sm:items-center', draft?.kind === 'remove' && 'opacity-40')}>
      <LayerSwatch url={url} tone={tone} />
      {onAnchor && anchor && draft?.kind !== 'remove' ? <label className="grid flex-1 gap-1 text-sm">
        <span className="font-medium">{t.logoAnchor}</span>
        <ChoiceSelect label={t.logoAnchor} value={anchor} disabled={busy} onValueChange={value => value && onAnchor(value as LogoAnchor)}
          options={logoAnchors.map(value => ({ value, label: anchorLabel(value, t) }))} />
      </label> : null}
    </div> : <DropArea onFile={actions.onFile} disabled={busy} accept={acceptedTypes.layer} label={t.chooseImage} types={t.layerTypes} />}
    <SlotStatusView status={status} t={t} onReload={actions.onReload} />
    {url || draft ? <SlotFooter has={Boolean(url)} draft={draft} busy={busy} accept={acceptedTypes.layer} actions={actions} t={t} /> : null}
  </Panel>;
}

/** Adds a logo for a language (or none) and a tone at a position; an existing key is replaced on save. */
export function AddLogo({ locale, onAdd, t }: {
  locale: string; onAdd: (input: { language: string; tone: LogoTone; anchor: LogoAnchor; file: File }) => void; t: EditorCopy;
}) {
  const id = useId();
  const [choice, setChoice] = useState<string>(NEUTRAL_LANGUAGE);
  const [other, setOther] = useState('');
  const [tone, setTone] = useState<LogoTone>('light');
  const [anchor, setAnchor] = useState<LogoAnchor>('start-bottom');
  const language = choice === 'other' ? canonicalTag(other) : choice;
  const options = [{ value: NEUTRAL_LANGUAGE, label: t.logoNeutralOption },
    ...uiLocales.map(value => ({ value, label: languageName(value, locale), lang: value })), { value: 'other', label: t.logoOtherLanguage }];
  return <section aria-labelledby={`${id}-title`} className="grid gap-4 rounded-2xl border border-border/70 border-dashed p-4 sm:p-5">
    <h4 id={`${id}-title`} className="font-semibold">{t.addLogoHeading}</h4>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="grid gap-1 text-sm">
        <span className="font-medium">{t.logoLanguage}</span>
        <ChoiceSelect label={t.logoLanguage} value={choice} onValueChange={value => value && setChoice(value)} options={options} />
      </label>
      {choice === 'other' ? <label className="grid gap-1 text-sm">
        <span className="font-medium">{t.logoLanguageTag}</span>
        <Input value={other} onChange={event => setOther(event.target.value)} aria-describedby={`${id}-tag`}
          aria-invalid={other.trim() !== '' && !language} autoComplete="off" spellCheck={false} />
        <span id={`${id}-tag`} className={cn('text-xs', other.trim() && !language ? 'text-destructive' : 'text-muted-foreground')}>
          {other.trim() && !language ? t.logoLanguageTagInvalid : t.logoLanguageTagHelp}</span>
      </label> : null}
      <div className="grid gap-1 text-sm sm:col-span-2">
        <span id={`${id}-tone`} className="font-medium">{t.logoTone}</span>
        <SegmentGroup aria-labelledby={`${id}-tone`} value={tone} onValueChange={details => details.value && setTone(details.value as LogoTone)}>
          {logoTones.map(value => <SegmentGroupItem key={value} value={value}><SegmentGroupItemText>{toneLabel(value, t)}</SegmentGroupItemText></SegmentGroupItem>)}
        </SegmentGroup>
        <span className="text-muted-foreground text-xs">{tone === 'light' ? t.toneLightHelp : t.toneDarkHelp}</span>
      </div>
      <label className="grid gap-1 text-sm sm:col-span-2">
        <span className="font-medium">{t.logoAnchor}</span>
        <ChoiceSelect label={t.logoAnchor} value={anchor} onValueChange={value => value && setAnchor(value as LogoAnchor)}
          options={logoAnchors.map(value => ({ value, label: anchorLabel(value, t) }))} />
      </label>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <FilePicker accept={acceptedTypes.layer} label={t.chooseLogo} disabled={!language} variant="default"
        onFile={file => language && onAdd({ language, tone, anchor, file })} />
      <span className="text-muted-foreground text-xs">{t.layerTypes}</span>
    </div>
  </section>;
}

/** Which logo the stage draws for each title language, or the live title. */
export function LogoCoverage({ rows, locale, t }: {
  rows: readonly { language: string; logo: { language: string } | null; darkOnly: boolean }[]; locale: string; t: EditorCopy;
}) {
  const id = useId();
  return <section aria-labelledby={`${id}-title`} className="grid gap-2">
    <h4 id={`${id}-title`} className="font-semibold text-sm">{t.coverageHeading}</h4>
    <p className="text-muted-foreground text-xs">{t.coverageHelp}</p>
    <table className="w-full text-sm">
      <thead className="sr-only"><tr><th scope="col">{t.coverageLanguage}</th><th scope="col">{t.coverageShows}</th></tr></thead>
      <tbody className="divide-y divide-border/60">
        {rows.map(row => <tr key={row.language}>
          <th scope="row" className="py-1.5 pe-3 text-start font-normal">{languageName(row.language, locale)}</th>
          <td className={cn('py-1.5 text-end', !row.logo && 'text-muted-foreground')}>
            {row.logo ? t.coverageLogo({ logo: row.logo.language ? languageName(row.logo.language, locale) : t.logoNeutral })
              : row.darkOnly ? t.coverageDarkOnly : t.coverageLiveTitle}</td>
        </tr>)}
      </tbody>
    </table>
  </section>;
}

export function TrailerCard({ saved, draft, status, busy, onChange, onSave, onRemove, onDiscard, onReload, t }: {
  saved: { url: string } | null; draft: { url: string; savedAs?: string } | null; status: SlotStatus | undefined; busy: boolean;
  onChange: (url: string) => void; onSave: () => void; onRemove: () => void; onDiscard: () => void; onReload: () => void; t: EditorCopy;
}) {
  const id = useId();
  const value = draft ? draft.url : saved?.url ?? '';
  const problem = draft && draft.url ? trailerProblem(draft.url) : null;
  const opening = value && !trailerProblem(value) ? trailerOpening(value.trim()) : null;
  const removing = draft !== null && !draft.url && Boolean(saved);
  return <Panel labelledBy={`${id}-title`} title={t.trailerTitle} help={t.trailerHelp} level={3}
    badge={<SlotBadge saved={Boolean(saved)} t={t}
      draft={removing ? { kind: 'remove', base: null, savedAs: draft?.savedAs } : draft ? { kind: 'trailer', savedAs: draft.savedAs } : undefined} />}>
    <label className="grid gap-1 text-sm">
      <span className="font-medium">{t.trailerLink}</span>
      <Input type="url" inputMode="url" value={value} disabled={busy} autoComplete="off" spellCheck={false}
        aria-invalid={Boolean(problem)} aria-describedby={`${id}-opening`} onChange={event => onChange(event.target.value)} />
    </label>
    <p id={`${id}-opening`} className={cn('flex items-start gap-2 text-sm', problem ? 'text-destructive' : 'text-muted-foreground')}>
      {problem ? { empty: t.trailerEmpty, 'not-https': t.trailerNotHttps, credentials: t.trailerCredentials, 'too-long': t.trailerTooLong }[problem]
        : opening ? <><PlayIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {opening.kind === 'tab' ? t.trailerOpensTab({ host: opening.host })
            : opening.provider === 'youtube' ? t.trailerOpensYoutube : t.trailerOpensBilibili}</> : t.trailerNone}
    </p>
    <SlotStatusView status={status} t={t} onReload={onReload} />
    <div className="flex flex-wrap items-center justify-between gap-2">
      {saved && !removing ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
        <Trash2Icon aria-hidden="true" />{t.removeTrailer}</Button> : <span />}
      {draft && !draft.savedAs ? <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onDiscard}><Undo2Icon aria-hidden="true" />{t.discard}</Button>
        <Button type="button" size="sm" disabled={busy || Boolean(problem) || (!draft.url && !saved)} isLoading={busy} onClick={onSave}>
          {busy ? t.saving : t.save}</Button>
      </div> : null}
    </div>
  </Panel>;
}
