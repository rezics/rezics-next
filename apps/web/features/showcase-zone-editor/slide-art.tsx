'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import type { ZoneShowcaseArt } from '@rezics/zone-sdk';
import { TriangleAlertIcon } from 'lucide-react';
import { useId } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import {
  type Draft, type LogoAnchor, logoCoverage, logoKey, logoSlot, NEUTRAL_LANGUAGE, type SlotKey,
} from '../showcase-editor/art.ts';
import { AddLogo, LogoCoverage, toneLabel } from '../showcase-editor/cards.tsx';
import { type BackgroundRole, phoneView } from '../showcase-editor/frame.ts';
import { languageName } from '../showcase-editor/language.ts';
import type { EditorCopy } from '../showcase-editor/messages.ts';
import { uiLocales } from '../../i18n/define.ts';
import { ArtCard, type ArtCardActions } from './art-card.tsx';
import type { ArtDrafts } from './art-drafts.ts';
import { type ArtSource, missingSlots, type Registry, savedArtOf } from './art.ts';
import type { ZoneEditorCopy } from './messages.ts';
import type { SlideDraft } from './slides.ts';

const imageDraft = (draft: Draft | undefined) => draft?.kind === 'image' ? draft : undefined;

/**
 * The art controls of one slide: backgrounds, logos and the cutout, the roles Work art has, plus
 * which art the stage will use for this slide. `stage` is the art the stage draws from these edits.
 */
export function SlideArtPanels({ slide, art, registry, realm, source, stage, locale, onAnchor, t, e }: {
  slide: SlideDraft; art: ArtDrafts; registry: Registry; realm: string | null; source: ArtSource; stage: ZoneShowcaseArt;
  locale: UiLocale; onAnchor: (slot: SlotKey, anchor: LogoAnchor) => void; t: ZoneEditorCopy; e: EditorCopy;
}) {
  const id = useId();
  const saved = savedArtOf(slide.art, registry);
  const missing = new Set(missingSlots(slide.art, registry));
  const drafts = art.drafts[slide.key] ?? {};
  const busy = (slot: SlotKey) => art.status(slide.key, slot)?.kind === 'busy';
  const actions = (slot: SlotKey, anchor?: LogoAnchor): ArtCardActions => ({
    onFile: file => void art.choose(slide.key, slot, file, anchor), onRemove: () => art.remove(slide.key, slot),
    onDiscard: () => art.discard(slide.key, slot), onAdd: () => void art.add(slide.key, slot) });
  const framedUrl = (slot: SlotKey) => { const image = saved.images[slot]; return image ? art.framed[image.selection]?.url : undefined; };

  // What a reader will get once the slide's changes are saved: a pending change, else the art the slide holds.
  const held = (role: BackgroundRole) => imageDraft(drafts[role]) ?? saved.images[role] ?? null;
  const landscape = held('background-landscape');
  const hasPortrait = Boolean(held('background-portrait'));
  const phone = landscape?.frame ? phoneView(landscape.frame, landscape.focal) : null;
  const portraitNote = hasPortrait || !landscape ? null
    : phone?.kind === 'cut' ? e.portraitMissingCut : phone?.reason === 'focal-too-wide' ? e.portraitMissingTooWide : e.portraitMissingWhole;

  const logoSlots = [...new Set([...Object.keys(slide.art), ...Object.keys(drafts)] as SlotKey[])].filter(slot => logoKey(slot))
    .sort((a, b) => (a.startsWith(`logo:${NEUTRAL_LANGUAGE}:`) ? -1 : 0) - (b.startsWith(`logo:${NEUTRAL_LANGUAGE}:`) ? -1 : 0) || a.localeCompare(b));
  const logoLanguages = [...new Set(logoSlots.map(slot => logoKey(slot)!.language).filter(language => language !== NEUTRAL_LANGUAGE))];
  const titleLanguages = [...new Set([...uiLocales, ...logoLanguages])];
  const logoName = (slot: SlotKey) => {
    const { language, tone } = logoKey(slot)!;
    return e.logoName({ language: languageName(language, locale, e.logoNeutral), tone: toneLabel(tone, e) });
  };
  const sourceText = { campaign: t.sourceOwn, work: t.sourceWork, cover: t.sourceCover, none: t.sourceNone }[source];
  const canAdd = Boolean(realm);

  const card = (slot: SlotKey, props: Partial<Parameters<typeof ArtCard>[0]> & { title: string }) => {
    const draft = imageDraft(drafts[slot]);
    return <ArtCard key={slot} role="layer" tone={null} saved={saved.images[slot]} missing={missing.has(slot)} draft={draft}
      status={art.status(slide.key, slot)} busy={busy(slot)} canAdd={canAdd} anchor={null} actions={actions(slot)} t={t} e={e}
      {...props} />;
  };

  return <section aria-labelledby={`${id}-title`} className="grid gap-6">
    <div className="grid gap-2">
      <h4 id={`${id}-title`} className="font-semibold text-lg">{t.artHeading}</h4>
      <p className="max-w-3xl text-pretty text-muted-foreground text-sm">{t.artIntro}</p>
      <p role="status" className="rounded-lg bg-muted px-3 py-2 text-pretty text-sm">{sourceText}</p>
      {realm ? null : <Alert variant="warning"><TriangleAlertIcon aria-hidden="true" /><AlertDescription>{t.noRealm}</AlertDescription></Alert>}
    </div>
    <div className="grid gap-4">
      <h5 className="font-semibold">{e.backgroundsHeading}</h5>
      {card('background-landscape', { role: 'background-landscape', title: e.landscapeTitle, help: e.landscapeHelp,
        showPhone: !hasPortrait, framedUrl: framedUrl('background-landscape'),
        onFrame: next => art.adjust(slide.key, 'background-landscape', next) })}
      {card('background-portrait', { role: 'background-portrait', title: e.portraitTitle, help: e.portraitHelp, note: portraitNote,
        framedUrl: framedUrl('background-portrait'), onFrame: next => art.adjust(slide.key, 'background-portrait', next) })}
    </div>
    <div className="grid gap-4">
      <div className="grid gap-1">
        <h5 className="font-semibold">{e.logosHeading}</h5>
        <p className="text-pretty text-muted-foreground text-sm">{e.logosHelp}</p>
      </div>
      {logoSlots.length ? logoSlots.map(slot => {
        const draft = imageDraft(drafts[slot]);
        const anchor = draft ? draft.anchor : slide.art[slot]?.anchor ?? saved.images[slot]?.anchor ?? null;
        return card(slot, { title: logoName(slot), tone: logoKey(slot)!.tone, anchor,
          onAnchor: value => draft ? art.adjust(slide.key, slot, { anchor: value }) : onAnchor(slot, value),
          level: 5 });
      }) : <p className="text-muted-foreground text-sm">{e.noLogos}</p>}
      <AddLogo locale={locale} t={e} onAdd={({ language, tone, anchor, file }) => void art.choose(slide.key, logoSlot(language, tone), file, anchor)} />
      <LogoCoverage rows={logoCoverage(stage, titleLanguages)} locale={locale} t={e} />
    </div>
    {card('cutout', { title: e.cutoutTitle, help: e.cutoutHelp, level: 5 })}
  </section>;
}
