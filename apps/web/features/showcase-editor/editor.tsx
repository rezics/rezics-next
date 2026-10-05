'use client';

import type { ZoneText, ZoneWork } from '@rezics/zone-sdk';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { type UiLocale, uiLocales } from '../../i18n/define.ts';
import type { WorkShowcase } from '../api/showcase.ts';
import type { ArtSelection } from './actions.ts';
import {
  type Draft, type Drafts, type Framed, type ImageDraft, type LogoAnchor, logoCoverage, logoKey, logoSlot,
  NEUTRAL_LANGUAGE, previewArt, savedArt, type SlotKey, slotsOf,
} from './art.ts';
import { AddLogo, BackgroundCard, LayerRow, LogoCoverage, type SlotActions, TrailerCard, toneLabel } from './cards.tsx';
import { decodedSize, drawFrame } from './draw.ts';
import { backgroundFrames, type BackgroundRole, initialFrame, percentArea, phoneView, type PixelRect } from './frame.ts';
import { declaresAlpha, fileProblem, pixelProblem } from './image-file.ts';
import { languageName } from './language.ts';
import type { ShowcaseEditorMessages } from './messages.ts';
import { ShowcasePreview } from './preview.tsx';
import type { SaveResult } from './refusal.ts';
import type { SlotStatus } from './status.tsx';
import { trailerProblem } from './trailer.ts';
import { uploadShowcaseImage } from './upload.ts';

// The editor keeps each slot's unsaved change apart from Main's selection, previews both together,
// and saves one slot at a time with the selection that change started from. When Main says the slot
// moved, nothing is overwritten: the person reloads, sees the other change, and decides again.

export interface ShowcaseEditorProps {
  work: { id: string; card: ZoneWork; title: ZoneText; tagline: ZoneText | null };
  art: WorkShowcase | null;
  actingSubject: string;
  locale: UiLocale;
  /** The raw catalog of the page locale; functions cannot cross from the server, so it is materialized here. */
  messages: ShowcaseEditorMessages;
  saveArt: (input: ArtSelection) => Promise<SaveResult>;
  saveTrailer: (input: { work: string; expectedSelection: string | null; url: string | null }) => Promise<SaveResult>;
  loadTitle: (work: string, language: string) => Promise<{ title: ZoneText; tagline: ZoneText | null } | null>;
  upload?: typeof uploadShowcaseImage;
}

type TrailerDraft = { base: string | null; url: string; savedAs?: string };
type StatusKey = SlotKey | 'trailer';
const backgrounds: readonly BackgroundRole[] = ['background-landscape', 'background-portrait'];
const isBackground = (slot: SlotKey): slot is BackgroundRole => slot === 'background-landscape' || slot === 'background-portrait';
const frameKey = (url: string, frame: PixelRect) => `${url}#${frame.left},${frame.top},${frame.width},${frame.height}`;

function release(draft: Draft | undefined) {
  if (draft?.kind !== 'image') return;
  if (draft.source.file) URL.revokeObjectURL(draft.source.url);
  if (draft.framed) URL.revokeObjectURL(draft.framed.url);
}

export function ShowcaseEditor({ work, art, actingSubject, locale, messages, saveArt, saveTrailer, loadTitle,
  upload = uploadShowcaseImage }: ShowcaseEditorProps) {
  const t = useMemo(() => materializeData(messages, { locale }), [messages, locale]);
  const router = useRouter();
  const saved = useMemo(() => savedArt(art, actingSubject), [art, actingSubject]);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [trailer, setTrailer] = useState<TrailerDraft | null>(null);
  const [statuses, setStatuses] = useState<Partial<Record<StatusKey, SlotStatus>>>({});
  const [framed, setFramed] = useState<Framed>({});
  const [reloading, startReload] = useTransition();
  const latest = useRef(drafts);
  latest.current = drafts;

  const setStatus = (slot: StatusKey, status?: SlotStatus) => setStatuses(all => ({ ...all, [slot]: status }));
  const putDraft = (slot: SlotKey, draft: Draft | undefined) => {
    latest.current = { ...latest.current, [slot]: draft };
    if (!draft) delete latest.current[slot];
    setDrafts(latest.current);
  };
  const busy = (slot: StatusKey) => statuses[slot]?.kind === 'busy';
  /** What a new change to a slot starts from: the selection Main recorded for the last change, else the one this change began on. */
  const baseOf = (slot: SlotKey, previous: Draft | undefined) =>
    previous?.savedAs ?? previous?.base ?? saved.images[slot]?.selection ?? null;

  // A saved change gives way to Main's selection once the refreshed page reads it.
  useEffect(() => {
    let changed = false;
    const next = { ...latest.current };
    for (const slot of Object.keys(next) as SlotKey[]) {
      const draft = next[slot];
      if (!draft?.savedAs) continue;
      const now = saved.images[slot]?.selection;
      if (draft.kind === 'remove' ? !now : now === draft.savedAs) {
        release(draft);
        delete next[slot];
        changed = true;
      }
    }
    if (changed) { latest.current = next; setDrafts(next); }
    setTrailer(current => current?.savedAs && (current.url ? saved.trailer?.selection === current.savedAs : !saved.trailer) ? null : current);
  }, [saved]);

  // The stage cannot crop, so each framed background is drawn at preview size once its frame settles.
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const slot of backgrounds) {
        const draft = drafts[slot];
        if (draft?.kind !== 'image' || !draft.frame) continue;
        const key = frameKey(draft.source.url, draft.frame);
        if (draft.framed?.key === key) continue;
        void drawFrame(draft.source.url, draft.frame, draft.source.size).then(drawn => {
          const now = latest.current[slot];
          if (!drawn || now?.kind !== 'image' || !now.frame || frameKey(now.source.url, now.frame) !== key) {
            if (drawn) URL.revokeObjectURL(drawn.url);
            return;
          }
          if (now.framed) URL.revokeObjectURL(now.framed.url);
          putDraft(slot, { ...now, framed: { ...drawn, key } });
        });
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [drafts]);

  // A selection whose width renditions Main has not made yet is drawn from its original and frame.
  useEffect(() => {
    for (const slot of backgrounds) {
      const image = saved.images[slot];
      if (!image || image.candidates.length || framed[image.selection]) continue;
      void drawFrame(image.url, image.frame, image.size).then(drawn => drawn && setFramed(all => ({ ...all, [image.selection]: drawn })));
    }
  }, [saved, framed]);

  async function choose(slot: SlotKey, file: File, anchor?: LogoAnchor) {
    const background = isBackground(slot);
    const problem = fileProblem(file, background ? 'background' : 'layer');
    if (problem) return setStatus(slot, { kind: 'file', problem });
    if (!background && !declaresAlpha(new Uint8Array(await file.arrayBuffer()))) return setStatus(slot, { kind: 'file', problem: 'alpha' });
    const url = URL.createObjectURL(file);
    const size = await decodedSize(url);
    const sizeProblem = size ? pixelProblem(size) : 'unreadable';
    const frame = background && size ? initialFrame(slot, size) : null;
    if (!size || sizeProblem || (background && !frame)) {
      URL.revokeObjectURL(url);
      return setStatus(slot, sizeProblem || !size ? { kind: 'file', problem: sizeProblem ?? 'unreadable' }
        : { kind: 'file', problem: 'small', size, min: backgroundFrames[slot as BackgroundRole].min });
    }
    const previous = latest.current[slot];
    release(previous);
    const savedImage = saved.images[slot];
    putDraft(slot, { kind: 'image', base: baseOf(slot, previous), source: { url, size, file, asset: null },
      frame, focal: null, framed: null, uploadKey: `showcase:${crypto.randomUUID()}`,
      anchor: logoKey(slot) ? anchor ?? (previous?.kind === 'image' ? previous.anchor : null) ?? savedImage?.anchor ?? 'start-bottom' : null });
    setStatus(slot, undefined);
  }

  /** Changes the frame, focal area or anchor of a slot, starting a change from the saved image when there is none. */
  function adjust(slot: SlotKey, change: Partial<Pick<ImageDraft, 'frame' | 'focal' | 'anchor' | 'adult'>>) {
    const current = latest.current[slot];
    const image = saved.images[slot];
    if (current?.kind === 'image') putDraft(slot, { ...current, ...change, base: baseOf(slot, current), savedAs: undefined });
    else if (image) putDraft(slot, { kind: 'image', base: baseOf(slot, current), framed: null, uploadKey: null,
      source: { url: image.url, size: image.size, file: null, asset: image.asset }, frame: isBackground(slot) ? image.frame : null,
      focal: image.focal, anchor: image.anchor, ...change });
    setStatus(slot, undefined);
  }

  function remove(slot: SlotKey) {
    const current = latest.current[slot];
    release(current);
    const image = saved.images[slot];
    putDraft(slot, image || current?.savedAs ? { kind: 'remove', base: baseOf(slot, current) } : undefined);
    setStatus(slot, undefined);
  }

  function discard(slot: SlotKey) {
    release(latest.current[slot]);
    putDraft(slot, undefined);
    setStatus(slot, undefined);
  }

  /** After a conflict: read Main again, and let the next save start from what Main now holds. */
  function reload(slot: StatusKey) {
    const status = statuses[slot];
    const current = status?.kind === 'refused' ? status.current : null;
    if (slot === 'trailer') setTrailer(draft => draft ? { ...draft, base: current } : draft);
    else {
      const draft = latest.current[slot];
      if (draft) putDraft(slot, { ...draft, base: current });
    }
    setStatus(slot, undefined);
    startReload(() => router.refresh());
  }

  async function save(slot: SlotKey) {
    const started = latest.current[slot];
    if (!started) return;
    const key = logoKey(slot);
    // The draft object changes while saving (a redrawn preview, a later nudge); the chosen file names the change.
    const same = (draft: Draft | undefined) => draft?.kind === started.kind
      && (draft.kind === 'remove' || (started.kind === 'image' && draft.source.url === started.source.url));
    setStatus(slot, { kind: 'busy', stage: 'saving' });
    let asset: string | null = null;
    if (started.kind === 'image') {
      asset = started.source.asset;
      if (!asset && started.source.file) {
        const uploaded = await upload({ file: started.source.file, actingSubject, adult: started.adult, key: started.uploadKey ?? `showcase:${crypto.randomUUID()}`,
          onStage: stage => setStatus(slot, { kind: 'busy', stage }), cancelled: () => !same(latest.current[slot]) });
        const now = latest.current[slot];
        if (!same(now) || now?.kind !== 'image') return;
        if (uploaded.status === 'refused') return setStatus(slot, { kind: 'upload', reason: uploaded.reason,
          ...(uploaded.retryAfter ? { retryAfter: uploaded.retryAfter } : {}) });
        asset = uploaded.asset;
        putDraft(slot, { ...now, source: { ...now.source, asset } });
        setStatus(slot, { kind: 'busy', stage: 'saving' });
      }
    }
    // What is saved is the change as it stands now, which may have been nudged during the upload.
    const draft = latest.current[slot]!;
    const image = draft.kind === 'image' ? draft : null;
    const result = await saveArt({ work: work.id, role: key ? 'logo' : slot as Exclude<ArtSelection['role'], 'logo'>,
      ...(key ? { language: key.language, tone: key.tone, anchor: image?.anchor ?? saved.images[slot]?.anchor ?? 'start-bottom' } : {}),
      expectedSelection: draft.base, asset,
      crop: image?.frame ? percentArea(image.frame, image.source.size) : null,
      focalArea: image?.frame && image.focal ? percentArea(image.focal, image.source.size) : null });
    if (result.status === 'done') {
      const now = latest.current[slot];
      if (now && same(now)) putDraft(slot, { ...now, savedAs: result.selection });
      setStatus(slot, { kind: 'saved', replayed: result.replayed });
      router.refresh();
    } else setStatus(slot, { kind: 'refused', refusal: result.refusal, detail: result.detail, current: result.current });
  }

  async function saveTrailerLink() {
    if (!trailer) return;
    const draft = trailer;
    setStatus('trailer', { kind: 'busy', stage: 'saving' });
    const result = await saveTrailer({ work: work.id, expectedSelection: draft.base, url: draft.url.trim() || null });
    if (result.status === 'done') {
      setTrailer(current => current === draft ? { ...current, savedAs: result.selection } : current);
      setStatus('trailer', { kind: 'saved', replayed: result.replayed });
      router.refresh();
    } else setStatus('trailer', { kind: 'refused', refusal: result.refusal, detail: result.detail, current: result.current });
  }

  const actions = (slot: SlotKey, anchor?: LogoAnchor): SlotActions => ({ onFile: file => void choose(slot, file, anchor),
    onRemove: () => remove(slot), onDiscard: () => discard(slot), onSave: () => void save(slot), onReload: () => reload(slot),
    onAdult: adult => adjust(slot, { adult }) });

  const stage = previewArt(saved, drafts, framed);
  /** A background a reader will get once the page's changes are saved: a pending change, else Main's selection. */
  const held = (role: BackgroundRole) => {
    const draft = drafts[role];
    return draft?.kind === 'image' ? draft : draft?.kind === 'remove' ? null : saved.images[role] ?? null;
  };
  const landscape = held('background-landscape');
  const hasPortrait = Boolean(held('background-portrait'));
  const phone = landscape?.frame ? phoneView(landscape.frame, landscape.focal) : null;
  const portraitNote = hasPortrait ? null : !landscape ? t.portraitMissingCover
    : phone?.kind === 'cut' ? t.portraitMissingCut : phone?.reason === 'focal-too-wide' ? t.portraitMissingTooWide : t.portraitMissingWhole;
  // A logo key someone just tried to add stays listed with its refusal, so the reason is shown where it belongs.
  const logoSlots = [...new Set([...slotsOf(saved, drafts), ...(Object.keys(statuses) as StatusKey[])
    .filter((slot): slot is SlotKey => slot !== 'trailer' && Boolean(statuses[slot]) && statuses[slot]?.kind !== 'saved')])].filter(slot => logoKey(slot))
    .sort((a, b) => (a.startsWith(`logo:${NEUTRAL_LANGUAGE}:`) ? -1 : 0) - (b.startsWith(`logo:${NEUTRAL_LANGUAGE}:`) ? -1 : 0) || a.localeCompare(b));
  const logoLanguages = [...new Set(logoSlots.map(slot => logoKey(slot)!.language).filter(language => language !== NEUTRAL_LANGUAGE))];
  const titleLanguages = [...new Set([...uiLocales, ...logoLanguages])];
  const trailerShown = trailer ? (trailer.url && !trailerProblem(trailer.url) ? trailer.url.trim() : trailer.url ? saved.trailer?.url ?? null : null)
    : saved.trailer?.url ?? null;
  const logoName = (slot: SlotKey) => {
    const { language, tone } = logoKey(slot)!;
    return t.logoName({ language: languageName(language, locale, t.logoNeutral), tone: toneLabel(tone, t) });
  };
  const loadPreviewTitle = useCallback((language: string) => loadTitle(work.id, language), [loadTitle, work.id]);

  return <div className="grid gap-8 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] xl:items-start">
    {/* A phone or tablet window is taller than the screen; the panel scrolls within the space under the header, so its controls stay reachable. */}
    <div className="order-1 xl:sticky xl:top-20 xl:order-2 xl:-mx-1 xl:max-h-[calc(100svh-6rem)] xl:overflow-y-auto xl:px-1">
      <ShowcasePreview work={work.card} title={work.title} tagline={work.tagline} art={stage} trailer={trailerShown}
        locale={locale} languages={logoLanguages} loadTitle={loadPreviewTitle} t={t} />
    </div>
    <div className="order-2 grid gap-10 xl:order-1">
      <section aria-labelledby="showcase-backgrounds" className="grid gap-4">
        <h3 id="showcase-backgrounds" className="font-semibold text-lg">{t.backgroundsHeading}</h3>
        {backgrounds.map(role => <BackgroundCard key={role} role={role} saved={saved.images[role]} draft={drafts[role]}
          status={statuses[role]} busy={busy(role) || reloading} actions={actions(role)} t={t}
          note={role === 'background-landscape' ? (landscape ? null : t.landscapeMissing) : portraitNote}
          showPhone={role === 'background-landscape' && !hasPortrait}
          onFrame={next => adjust(role, next)} />)}
      </section>
      <section aria-labelledby="showcase-logos" className="grid gap-4">
        <div className="grid gap-1">
          <h3 id="showcase-logos" className="font-semibold text-lg">{t.logosHeading}</h3>
          <p className="text-pretty text-muted-foreground text-sm">{t.logosHelp}</p>
        </div>
        {logoSlots.length ? logoSlots.map(slot => {
          const draft = drafts[slot];
          const anchor = draft?.kind === 'image' ? draft.anchor : saved.images[slot]?.anchor ?? null;
          return <LayerRow key={slot} title={logoName(slot)} tone={logoKey(slot)!.tone} saved={saved.images[slot]} draft={draft}
            status={statuses[slot]} busy={busy(slot) || reloading} anchor={anchor} onAnchor={value => adjust(slot, { anchor: value })}
            help={draft?.kind === 'image' && draft.source.file && saved.images[slot] ? t.logoReplaces({ logo: logoName(slot) }) : undefined}
            actions={actions(slot, anchor ?? undefined)} t={t} />;
        }) : <p className="text-muted-foreground text-sm">{t.noLogos}</p>}
        <AddLogo locale={locale} t={t} onAdd={({ language, tone, anchor, file }) => void choose(logoSlot(language, tone), file, anchor)} />
        <LogoCoverage rows={logoCoverage(stage, titleLanguages)} locale={locale} t={t} />
      </section>
      <LayerRow level={3} title={t.cutoutTitle} help={t.cutoutHelp} tone={null} saved={saved.images.cutout} draft={drafts.cutout}
        status={statuses.cutout} busy={busy('cutout') || reloading} anchor={null} actions={actions('cutout')} t={t} />
      <TrailerCard saved={saved.trailer} draft={trailer} status={statuses.trailer} busy={busy('trailer') || reloading} t={t}
        onChange={url => {
          setStatus('trailer', undefined);
          setTrailer(current => url.trim() === (saved.trailer?.url ?? '') && saved.trailer && !current?.savedAs ? null
            : { base: current?.savedAs ?? current?.base ?? saved.trailer?.selection ?? null, url });
        }}
        onRemove={() => setTrailer(current => ({ base: current?.savedAs ?? current?.base ?? saved.trailer?.selection ?? null, url: '' }))}
        onDiscard={() => { setTrailer(null); setStatus('trailer', undefined); }}
        onSave={() => void saveTrailerLink()} onReload={() => reload('trailer')} />
    </div>
  </div>;
}
