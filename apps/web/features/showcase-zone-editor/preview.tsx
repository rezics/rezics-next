'use client';

import { Button } from '@rezics/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@rezics/ui/dialog';
import { SegmentGroup, SegmentGroupItem, SegmentGroupItemText } from '@rezics/ui/segment-group';
import { ChoiceSelect } from '@rezics/ui/select';
import { direction } from '@rezics/main/language';
import type { ZoneShowcaseSlide, ZoneTitleEffect } from '@rezics/zone-sdk';
import { Maximize2Icon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { catalogs as uiCatalogs } from '../../i18n/catalogs.ts';
import { isUiLocale, localeNames, type UiLocale, uiLocales } from '../../i18n/define.ts';
import type { EditorCopy } from '../showcase-editor/messages.ts';
import { languageName } from '../showcase-editor/language.ts';
import { PreviewFrame, previewWindows, type PreviewWindow, RTL_SAMPLE } from '../showcase-editor/preview.tsx';
import { Showcase } from '../showcase/showcase.tsx';
import { messages as zoneEnglish, type ZoneMessages } from '../zones/messages.ts';
import type { ZoneEditorCopy } from './messages.ts';

// The preview draws the real showcase stage, as `Showcase` does on the Zone's home, inside an
// iframe the size of a reader's window (the stage picks its shape from the window). Rotation is off
// so the slide being edited stays in view. The editor owns the slides; this owns the window and
// the reader language, because the language changes which translations the slides show.

export function ZonePreview({ slidesFor, effect, locale, t, e }: {
  /** The slides as a reader of this language sees them. */
  slidesFor: (reader: UiLocale) => ZoneShowcaseSlide[];
  effect: ZoneTitleEffect; locale: UiLocale; t: ZoneEditorCopy; e: EditorCopy;
}) {
  const ids = useId();
  const [shape, setShape] = useState<PreviewWindow>('desktop');
  // Start from the window the editor itself is in: a phone editor first sees the phone card.
  useEffect(() => {
    if (matchMedia('(width < 768px)').matches) setShape('phone');
    else if (matchMedia('(width < 1200px)').matches) setShape('tablet');
  }, []);
  const [enlarged, setEnlarged] = useState(false);
  const [language, setLanguage] = useState<string>(locale);
  const [catalogs, setCatalogs] = useState<Partial<Record<UiLocale, ZoneMessages>>>({ en: zoneEnglish });
  const reader: UiLocale = isUiLocale(language) ? language : 'en';
  useEffect(() => {
    if (reader === 'en' || catalogs[reader]) return;
    let current = true;
    // A catalog that fails to load leaves the stage in English, as the site does for a missing translation.
    uiCatalogs.zones[reader]().then(catalog => { if (current) setCatalogs(all => ({ ...all, [reader]: catalog as ZoneMessages })); },
      () => { if (current) setCatalogs(all => ({ ...all, [reader]: zoneEnglish })); });
    return () => { current = false; };
  }, [reader, catalogs]);
  const options = [...uiLocales, RTL_SAMPLE].map(value => {
    const name = isUiLocale(value) ? localeNames[value] : languageName(value, locale);
    return { value, label: direction(value) === 'rtl' ? e.previewRtl({ language: name }) : name };
  });
  const frame = previewWindows.find(item => item.id === shape)!;
  const windowName = { phone: e.previewPhone, tablet: e.previewTablet, desktop: e.previewDesktop }[shape];
  const slides = slidesFor(reader);
  const stage = (large: boolean) => <PreviewFrame key={`${shape}-${large}`} window={frame} title={e.previewFrame({ window: windowName })}>
    <div lang={language} dir={direction(language)}>
      <Showcase slides={slides} label={e.previewStage} locale={reader} messages={catalogs[reader] ?? zoneEnglish}
        direction={direction(language)} rotation={false} effect={effect} />
    </div>
  </PreviewFrame>;
  return <section aria-labelledby={`${ids}-heading`} className="grid grid-cols-[minmax(0,1fr)] gap-3">
    <div className="grid gap-1">
      <h3 id={`${ids}-heading`} className="font-semibold text-lg">{e.previewHeading}</h3>
      <p className="text-muted-foreground text-sm">{e.previewHelp}</p>
    </div>
    <div className="flex flex-wrap items-end gap-3">
      <div className="max-w-full overflow-x-auto pb-1">
        <SegmentGroup value={shape} onValueChange={details => details.value && setShape(details.value as PreviewWindow)} aria-label={e.previewWindow}>
          {previewWindows.map(item => <SegmentGroupItem key={item.id} value={item.id}>
            <SegmentGroupItemText>{{ phone: e.previewPhone, tablet: e.previewTablet, desktop: e.previewDesktop }[item.id]}</SegmentGroupItemText>
          </SegmentGroupItem>)}
        </SegmentGroup>
      </div>
      <label className="grid min-w-44 flex-1 gap-1 text-sm">
        <span className="font-medium">{e.previewLanguage}</span>
        <ChoiceSelect options={options} value={language} onValueChange={value => value && setLanguage(value)} label={e.previewLanguage} />
      </label>
    </div>
    {slides.length ? stage(false) : <p className="grid min-h-40 place-content-center rounded-xl border border-border/70 border-dashed p-6 text-center text-muted-foreground text-sm">
      {t.previewNothing}</p>}
    <p className="text-muted-foreground text-xs">{t.previewHint}</p>
    <p className="text-muted-foreground text-xs">{t.previewMasked}</p>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-muted-foreground text-xs">{shape === 'desktop' ? e.previewPointer : null}</p>
      {slides.length ? <Dialog open={enlarged} onOpenChange={details => setEnlarged(details.open)} lazyMount unmountOnExit>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm"><Maximize2Icon aria-hidden="true" />{e.previewEnlarge}</Button></DialogTrigger>
        <DialogContent size="6xl" bottomStickOnMobile={false} className="grid gap-4 p-4 pt-12 sm:p-6 sm:pt-12">
          <DialogTitle>{e.previewFrame({ window: windowName })}</DialogTitle>
          {enlarged ? stage(true) : null}
        </DialogContent>
      </Dialog> : null}
    </div>
  </section>;
}
