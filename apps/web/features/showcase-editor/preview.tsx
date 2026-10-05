'use client';

import { Button } from '@rezics/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@rezics/ui/dialog';
import { EnvironmentProvider } from '@rezics/ui/environment';
import { ChoiceSelect } from '@rezics/ui/select';
import { SegmentGroup, SegmentGroupItem, SegmentGroupItemText } from '@rezics/ui/segment-group';
import { direction } from '@rezics/main/language';
import type { ZoneShowcaseArt, ZoneText, ZoneWork } from '@rezics/zone-sdk';
import { Maximize2Icon } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { catalogs as uiCatalogs } from '../../i18n/catalogs.ts';
import { isUiLocale, localeNames, type UiLocale, uiLocales } from '../../i18n/define.ts';
import { Showcase } from '../showcase/showcase.tsx';
import { messages as zoneEnglish, type ZoneMessages } from '../zones/messages.ts';
import { previewSlides } from './art.ts';
import { languageName } from './language.ts';
import type { EditorCopy } from './messages.ts';

// The preview draws the real showcase stage inside an iframe the size of a reader's window. The
// stage is CSS only and picks its shape from the window (media queries), so a smaller box on this
// page would show the wrong stage; an iframe has a window of its own. React renders into it
// through a portal, so every unsaved change reaches the stage at once.

export const previewWindows = [
  { id: 'phone', width: 390, height: 844 },
  { id: 'tablet', width: 820, height: 1180 },
  { id: 'desktop', width: 1280, height: 860 },
] as const;
export type PreviewWindow = (typeof previewWindows)[number]['id'];

/** A language right to left in reading order, for the preview of a mirrored page. */
export const RTL_SAMPLE = 'ar';

/** Keeps the iframe's stylesheets and root classes those of this page, including ones loaded or replaced later. */
function mirrorDocument(from: Document, to: Document) {
  const clones = new Map<Node, Node>();
  const sync = () => {
    const sources = [...from.head.querySelectorAll('link[rel="stylesheet"], style')];
    for (const [source, clone] of clones) if (!sources.includes(source as Element)) { clone.parentNode?.removeChild(clone); clones.delete(source); }
    for (const source of sources) {
      const clone = clones.get(source);
      if (!clone) { const copy = source.cloneNode(true); clones.set(source, copy); to.head.append(copy); }
      else if (source.textContent !== clone.textContent) clone.textContent = source.textContent;
    }
    to.documentElement.className = from.documentElement.className;
    to.documentElement.style.cssText = from.documentElement.style.cssText;
    to.body.className = from.body.className;
    to.body.style.cssText = `${from.body.style.cssText};margin:0;background:transparent`;
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(from.head, { childList: true, subtree: true, characterData: true });
  observer.observe(from.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  return () => observer.disconnect();
}

/** One reader window: an iframe of the window's size, scaled to fit, showing as much as the stage needs. */
export function PreviewFrame({ window: frame, title, children }: {
  window: (typeof previewWindows)[number]; title: string; children: ReactNode;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const [fit, setFit] = useState(0.5);
  const [content, setContent] = useState(frame.height * 0.6);
  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    let frameRequest = 0;
    // Only the width sets the scale; the height follows the stage, which must not feed back into it.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frameRequest);
      frameRequest = requestAnimationFrame(() => setFit(Math.min(1, element.clientWidth / frame.width)));
    });
    observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(frameRequest); };
  }, [frame.width]);
  useEffect(() => {
    // The iframe keeps its first, empty same-origin document: it has no src, so nothing navigates it away.
    const element = iframe.current;
    const doc = element?.contentDocument;
    const view = element?.contentWindow as (Window & typeof globalThis) | null | undefined;
    if (!doc || !view) return;
    if (!doc.body) doc.documentElement.append(doc.createElement('body'));
    const stop = mirrorDocument(document, doc);
    const root = doc.createElement('div');
    root.className = 'py-4';
    doc.body.replaceChildren(root);
    // A preview link must not move this page: a slide's own links are inert here; trailers open their own tab.
    const inert = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('a');
      if (link && link.target !== '_blank') { event.preventDefault(); event.stopPropagation(); }
    };
    doc.addEventListener('click', inert, true);
    let frameRequest = 0;
    const measure = new view.ResizeObserver(() => {
      view.cancelAnimationFrame(frameRequest);
      frameRequest = view.requestAnimationFrame(() => setContent(Math.ceil(root.getBoundingClientRect().height)));
    });
    measure.observe(root);
    setMount(root);
    return () => { stop(); measure.disconnect(); view.cancelAnimationFrame(frameRequest); doc.removeEventListener('click', inert, true); setMount(null); };
  }, []);
  const visible = Math.min(content, frame.height);
  return <div ref={holder} className="relative w-full overflow-hidden rounded-xl border border-border/70 bg-background"
    style={{ height: Math.ceil(visible * fit) }}>
    <iframe ref={iframe} title={title}
      className="absolute top-0 left-0 origin-top-left border-0 bg-background"
      style={{ width: frame.width, height: frame.height, transform: `scale(${fit})` }} />
    {mount ? createPortal(<EnvironmentProvider value={() => mount.ownerDocument}>{children}</EnvironmentProvider>, mount) : null}
  </div>;
}

/**
 * The preview panel: the window, the reader language (right-to-left included), and the stage with
 * the Work's slide between two neighbours, so the next card peeks on a phone and the wide stage
 * lists what is coming.
 */
export function ShowcasePreview({ work, title, tagline, art, trailer, locale, languages, loadTitle, t }: {
  work: ZoneWork; title: ZoneText; tagline: ZoneText | null; art: ZoneShowcaseArt; trailer: string | null;
  locale: UiLocale; languages: readonly string[]; t: EditorCopy;
  loadTitle: (language: string) => Promise<{ title: ZoneText; tagline: ZoneText | null } | null>;
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
  const [titles, setTitles] = useState<Record<string, { title: ZoneText; tagline: ZoneText | null } | null>>({ [locale]: { title, tagline } });
  const [catalogs, setCatalogs] = useState<Partial<Record<UiLocale, ZoneMessages>>>({ en: zoneEnglish });
  const reader: UiLocale = isUiLocale(language) ? language : 'en';
  useEffect(() => { setTitles(current => ({ ...current, [locale]: { title, tagline } })); }, [locale, title, tagline]);
  useEffect(() => {
    if (language in titles) return;
    let current = true;
    loadTitle(language).then(found => { if (current) setTitles(all => ({ ...all, [language]: found })); },
      () => { if (current) setTitles(all => ({ ...all, [language]: null })); });
    return () => { current = false; };
  }, [language, titles, loadTitle]);
  useEffect(() => {
    if (reader === 'en' || catalogs[reader]) return;
    let current = true;
    // A catalog that fails to load leaves the stage in English, as the site does for a missing translation.
    uiCatalogs.zones[reader]().then(catalog => { if (current) setCatalogs(all => ({ ...all, [reader]: catalog as ZoneMessages })); },
      () => { if (current) setCatalogs(all => ({ ...all, [reader]: zoneEnglish })); });
    return () => { current = false; };
  }, [reader, catalogs]);
  const shown = titles[language] ?? titles[locale] ?? { title, tagline };
  const options = [...new Set([...uiLocales, ...languages, RTL_SAMPLE])].map(value => {
    const name = isUiLocale(value) ? localeNames[value] : languageName(value, locale);
    return { value, label: direction(value) === 'rtl' ? t.previewRtl({ language: name }) : name };
  });
  const frame = previewWindows.find(item => item.id === shape)!;
  const windowName = { phone: t.previewPhone, tablet: t.previewTablet, desktop: t.previewDesktop }[shape];
  const slides = previewSlides({ work, title: shown.title, tagline: shown.tagline, art, trailer,
    neighbours: [{ value: t.previewNext, lang: locale, dir: direction(locale, t.previewNext) },
      { value: t.previewAnother, lang: locale, dir: direction(locale, t.previewAnother) }] });
  const stage = (large: boolean) => <PreviewFrame key={`${shape}-${large}`} window={frame} title={t.previewFrame({ window: windowName })}>
    <div lang={language} dir={direction(language)}>
      <Showcase slides={slides} label={t.previewStage} locale={reader} messages={catalogs[reader] ?? zoneEnglish}
        direction={direction(language)} rotation={false} />
    </div>
  </PreviewFrame>;
  return <section aria-labelledby={`${ids}-heading`} className="grid gap-3">
    <div className="grid gap-1">
      <h3 id={`${ids}-heading`} className="font-semibold text-lg">{t.previewHeading}</h3>
      <p className="text-muted-foreground text-sm">{t.previewHelp}</p>
    </div>
    <div className="flex flex-wrap items-end gap-3">
      <SegmentGroup value={shape} onValueChange={details => details.value && setShape(details.value as PreviewWindow)}
        aria-label={t.previewWindow}>
        {previewWindows.map(item => <SegmentGroupItem key={item.id} value={item.id}>
          <SegmentGroupItemText>{{ phone: t.previewPhone, tablet: t.previewTablet, desktop: t.previewDesktop }[item.id]}</SegmentGroupItemText>
        </SegmentGroupItem>)}
      </SegmentGroup>
      <label className="grid min-w-44 flex-1 gap-1 text-sm">
        <span className="font-medium">{t.previewLanguage}</span>
        <ChoiceSelect options={options} value={language} onValueChange={value => value && setLanguage(value)} label={t.previewLanguage} />
      </label>
    </div>
    {stage(false)}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-muted-foreground text-xs">{shape === 'desktop' ? t.previewPointer : null}</p>
      <Dialog open={enlarged} onOpenChange={details => setEnlarged(details.open)} lazyMount unmountOnExit>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm"><Maximize2Icon aria-hidden="true" />{t.previewEnlarge}</Button></DialogTrigger>
        <DialogContent size="6xl" bottomStickOnMobile={false} className="grid gap-4 p-4 pt-12 sm:p-6 sm:pt-12">
          <DialogTitle>{t.previewFrame({ window: windowName })}</DialogTitle>
          {enlarged ? stage(true) : null}
        </DialogContent>
      </Dialog>
    </div>
  </section>;
}
