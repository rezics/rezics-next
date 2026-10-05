'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import type { ZoneTitleEffect, ZoneWork } from '@rezics/zone-sdk';
import { CircleCheckIcon, LinkIcon, PlusIcon, RefreshCwIcon, TriangleAlertIcon, Undo2Icon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { previewArt } from '../showcase-editor/art.ts';
import type { ShowcaseEditorMessages } from '../showcase-editor/messages.ts';
import { uploadShowcaseImage } from '../showcase-editor/upload.ts';
import type { WorkLevelsEditMessages } from '../work-levels-edit/messages.ts';
import { workIri } from '../work-levels-edit/route.ts';
import { type WorkLoader, WorkPicker } from '../work-levels-edit/work-picker.tsx';
import type { addCampaignArt, readLatestShowcase, readSlideWorks, saveShowcase } from './actions.ts';
import { useArtDrafts } from './art-drafts.ts';
import { artSourceOf, previewSlides, type Registry, savedArtOf } from './art.ts';
import { TitleEffectField } from './effect-field.tsx';
import type { ZoneShowcaseEditorMessages } from './messages.ts';
import { ZonePreview } from './preview.tsx';
import type { ConfigurationRefusal } from './refusal.ts';
import { SlideArtPanels } from './slide-art.tsx';
import { ScheduleFields, TargetFields, WordsFields } from './slide-fields.tsx';
import { SlideList, slideName } from './slide-list.tsx';
import {
  blankSlide, documentFor, documentOf, draftOf, dropSlide, fingerprint, MAX_SLIDES, moveSlide, needsShowcaseModule,
  type PresentationDocument, RECOMMENDED_SLIDES, type SlideDraft, slideProblems, type StoredPresentation,
} from './slides.ts';

// The editor keeps the Zone's showcase as a document of its own (slides in order and the title
// effect), previews it on the real stage, and saves it with one write that names the Zone revision
// it started from. When Main says the Zone moved, nothing is overwritten: the person reloads the
// latest revision, which keeps their slides, and decides again. An image a person adds to a slide
// is uploaded and made campaign art at once (so a slow or refused image is reported where it was
// chosen), but readers see it only after the showcase is saved.

export interface ZoneShowcaseEditorProps {
  /** The Zone's UUID. */
  zone: string;
  /** The Realm campaign art belongs to (an IRI); null for a Zone with no default Realm. */
  realm: string | null;
  actingSubject: string;
  locale: UiLocale;
  /** The Zone revision a save must name. */
  head: string;
  stored: Exclude<StoredPresentation, { kind: 'reference' }>;
  /** Campaign images Main delivers, by Use. */
  registry: Registry;
  /** The Works the slides name, as the stage draws them. */
  works: Record<string, ZoneWork | null>;
  /** The title of the showcase area a Zone without one gets when its slides are first saved. */
  heroTitle: string;
  /** The raw catalogs of the page locale; functions cannot cross from the server, so they are materialized here. */
  messages: ZoneShowcaseEditorMessages;
  editorMessages: ShowcaseEditorMessages;
  pickerMessages: WorkLevelsEditMessages;
  save: typeof saveShowcase;
  addArt: typeof addCampaignArt;
  readWorks: typeof readSlideWorks;
  readLatest: typeof readLatestShowcase;
  upload?: typeof uploadShowcaseImage;
  /** Finds Works by title for the picker; Main's typeahead unless a story or test supplies its own. */
  loadWorks?: WorkLoader;
  /** The time schedules are read against, for stories and tests. */
  now?: number;
}

type SaveStatus =
  | { kind: 'busy' }
  | { kind: 'saved'; replayed: boolean }
  | { kind: 'refused'; refusal: ConfigurationRefusal; detail: string | null }
  | { kind: 'reloaded'; count: number }
  | { kind: 'reload-failed' };

type Baseline = { slides: SlideDraft[]; effect: ZoneTitleEffect };
const baselineOf = (document: PresentationDocument): Baseline =>
  ({ slides: document.slides.map(slide => draftOf(slide)), effect: document.tokens.titleEffect });

export function ZoneShowcaseEditor({ zone, realm, actingSubject, locale, head: initialHead, stored, registry: initialRegistry, works: initialWorks,
  heroTitle, messages, editorMessages, pickerMessages, save, addArt, readWorks, readLatest, upload = uploadShowcaseImage, loadWorks, now: nowProp }: ZoneShowcaseEditorProps) {
  const t = useMemo(() => materializeData(messages, { locale }), [messages, locale]);
  const e = useMemo(() => ({ ...materializeData(editorMessages, { locale }), savedNotice: t.slotAdded, savedReplayed: t.slotAddedReplayed,
    refusalDenied: t.slotRefusalDenied, refusalGone: t.slotRefusalGone, uploadHeld: t.slotUploadHeld, uploadSlow: t.slotUploadSlow,
    stageSaving: t.slotAdding }), [editorMessages, locale, t]);
  const [now] = useState(() => nowProp ?? Date.now());
  const [head, setHead] = useState(initialHead);
  const [base, setBase] = useState(() => documentOf(stored));
  const [baseline, setBaseline] = useState<Baseline>(() => baselineOf(documentOf(stored)));
  const [slides, setSlides] = useState<SlideDraft[]>(baseline.slides);
  const [effect, setEffect] = useState<ZoneTitleEffect>(baseline.effect);
  const [selected, setSelected] = useState<string | null>(baseline.slides[0]?.key ?? null);
  const [registry, setRegistry] = useState(initialRegistry);
  const [works, setWorks] = useState(initialWorks);
  const [loadingWorks, setLoadingWorks] = useState<ReadonlySet<string>>(new Set());
  const [pickingWork, setPickingWork] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [status, setStatus] = useState<SaveStatus | undefined>();

  const updateSlide = useCallback((key: string, change: Partial<SlideDraft>) =>
    setSlides(all => all.map(slide => slide.key === key ? { ...slide, ...change } : slide)), []);
  const setArt = useCallback((key: string, update: (art: SlideDraft['art']) => SlideDraft['art']) =>
    setSlides(all => all.map(slide => slide.key === key ? { ...slide, art: update(slide.art) } : slide)), []);
  const art = useArtDrafts({ zone, realm, actingSubject, registry, setRegistry, setArt, addArt, upload });

  /** Reads the cards of Works the editor has not read yet; a Work Main cannot show stays null. */
  const ensureWorks = useCallback((iris: readonly string[], known: Readonly<Record<string, unknown>> = works) => {
    const wanted = [...new Set(iris)].filter(iri => iri && !(iri in known));
    if (!wanted.length || !realm) return;
    setLoadingWorks(all => new Set([...all, ...wanted]));
    void readWorks({ realm, locale, works: wanted }).then(found => {
      setWorks(all => ({ ...all, ...Object.fromEntries(wanted.map(iri => [iri, found[iri] ?? null])) }));
    }, () => {
      setWorks(all => ({ ...all, ...Object.fromEntries(wanted.map(iri => [iri, null])) }));
    }).finally(() => setLoadingWorks(all => new Set([...all].filter(iri => !wanted.includes(iri)))));
  }, [works, realm, readWorks, locale]);
  // A Work that is not here yet (after a reload) is read once.
  useEffect(() => {
    ensureWorks(slides.flatMap(slide => slide.target.kind === 'work' ? [slide.target.work] : []));
  }, [slides, ensureWorks]);

  const dirty = fingerprint(slides, effect) !== fingerprint(baseline.slides, baseline.effect);
  const invalid = slides.some(slide => slideProblems(slide).length > 0);
  const saving = status?.kind === 'busy';
  const canSave = dirty && !invalid && art.pending === 0 && !art.busy && !saving;
  // Leaving with changes nobody saved asks first: nothing the person did reaches readers until it is saved.
  const unsaved = dirty || art.pending > 0;
  useEffect(() => {
    if (!unsaved) return;
    const ask = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [unsaved]);
  const selectedSlide = slides.find(slide => slide.key === selected) ?? null;
  const worksOf = (slide: SlideDraft) => slide.target.kind === 'work' ? works[slide.target.work] : null;

  const stage = previewSlides({ slides, works, registry, drafts: art.drafts, framed: art.framed, reader: locale });
  const sources = Object.fromEntries(slides.flatMap(slide => {
    const drawn = stage.find(item => item.id === slide.id);
    return drawn ? [[slide.key, artSourceOf(drawn)] as const] : [];
  }));

  function announceMove(list: readonly SlideDraft[], key: string) {
    const moved = list.find(slide => slide.key === key)!;
    setAnnouncement(t.moved({ slide: slideName(moved, worksOf(moved), locale, t), position: String(list.indexOf(moved) + 1), count: String(list.length) }));
  }
  function move(key: string, offset: -1 | 1) {
    const next = moveSlide(slides, key, offset);
    setSlides(next);
    announceMove(next, key);
  }
  function drop(key: string, target: string) {
    const next = dropSlide(slides, key, target);
    setSlides(next);
    announceMove(next, key);
  }
  function remove(key: string) {
    const index = slides.findIndex(slide => slide.key === key);
    art.forget(key);
    const next = slides.filter(slide => slide.key !== key);
    setSlides(next);
    if (selected === key) setSelected(next[Math.min(index, next.length - 1)]?.key ?? null);
  }
  function addSlide(slide: SlideDraft) {
    setSlides(all => [...all, slide]);
    setSelected(slide.key);
    setPickingWork(false);
    setAnnouncement(t.slideLabel({ index: String(slides.length + 1) }));
  }
  const taken = () => slides.map(slide => slide.id);

  async function saveAll() {
    const sent = { slides, effect };
    const document = documentFor(base, sent.slides, sent.effect, { title: heroTitle });
    setStatus({ kind: 'busy' });
    const result = await save({ zone, expectedHead: head, presentation: document });
    if (result.status === 'done') {
      setHead(result.revision);
      setBase(document);
      // What was saved is what was sent; edits made while saving stay unsaved.
      setBaseline(sent);
      setStatus({ kind: 'saved', replayed: result.replayed });
    } else setStatus({ kind: 'refused', refusal: result.refusal, detail: result.detail });
  }

  /** After a conflict: read the Zone again and let the next save start from what it holds now; the person's slides stay. */
  async function reload() {
    setStatus({ kind: 'busy' });
    const latest = await readLatest({ zone }).catch(() => ({ status: 'unavailable' as const }));
    if (latest.status !== 'read' || latest.state.presentation.kind === 'reference') return setStatus({ kind: 'reload-failed' });
    const document = documentOf(latest.state.presentation);
    const theirs = baselineOf(document);
    // What the person has not changed follows the Zone; what they changed stays theirs.
    if (fingerprint(slides, baseline.effect) === fingerprint(baseline.slides, baseline.effect)) {
      setSlides(theirs.slides);
      setSelected(theirs.slides[0]?.key ?? null);
    }
    if (effect === baseline.effect) setEffect(theirs.effect);
    setHead(latest.state.revision);
    setBase(document);
    setBaseline(theirs);
    setRegistry(all => ({ ...all, ...latest.registry }));
    setStatus({ kind: 'reloaded', count: theirs.slides.length });
  }

  function discardAll() {
    art.reset();
    setSlides(baseline.slides);
    setEffect(baseline.effect);
    setSelected(baseline.slides[0]?.key ?? null);
    setStatus(undefined);
  }

  const heroNeeded = needsShowcaseModule(base, slides);
  const sampleSlide = slides[0];
  const sampleText = sampleSlide ? slideName(sampleSlide, worksOf(sampleSlide), locale, t) : t.effectSampleText;
  const selectedStage = selectedSlide ? previewArt(savedArtOf(selectedSlide.art, registry), art.drafts[selectedSlide.key] ?? {}, art.framed) : null;
  const refusalText = (refusal: ConfigurationRefusal) => ({ 'sign-in': t.refusalSignIn, denied: t.refusalDenied, gone: t.refusalGone, conflict: t.refusalConflict,
    invalid: t.refusalInvalid, repeat: t.refusalRepeat, limited: t.refusalLimited, pending: t.refusalPending, unavailable: t.refusalUnavailable })[refusal];

  return <div className="grid gap-6">
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8 xl:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] xl:items-start">
      <div className="order-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-10 xl:order-1">
        <section aria-labelledby="zone-showcase-slides" className="grid gap-4">
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <div className="grid gap-1">
              <h3 id="zone-showcase-slides" className="font-semibold text-lg">{t.slidesHeading}</h3>
              <p className="max-w-3xl text-pretty text-muted-foreground text-sm">{t.slidesHelp}</p>
            </div>
            <Badge variant={slides.length > RECOMMENDED_SLIDES ? 'warning' : 'outline'}>{t.slideCount({ count: String(slides.length), max: String(MAX_SLIDES) })}</Badge>
          </div>
          <p className="text-pretty text-muted-foreground text-xs">{t.slidesRecommend}</p>
          {slides.length ? <SlideList slides={slides} selected={selected} works={works} loading={loadingWorks} now={now} locale={locale} sources={sources}
            onSelect={setSelected} onMove={move} onDrop={drop} onRemove={remove} t={t} />
            : <div className="grid gap-1 rounded-2xl border border-border/70 border-dashed p-6 text-center">
              <p className="font-medium">{t.emptyTitle}</p>
              <p className="text-muted-foreground text-sm">{t.emptyBody}</p>
            </div>}
          <p role="status" className="sr-only">{announcement}</p>
          {pickingWork ? <div className="grid gap-3 rounded-2xl border border-border/70 bg-card p-4">
            <div className="grid gap-1">
              <h4 className="font-semibold">{t.addWorkHeading}</h4>
              <p className="text-muted-foreground text-sm">{t.addWorkHelp}</p>
            </div>
            <WorkPicker name="zone-showcase-new-work" locale={locale} t={materializeData(pickerMessages, { locale })} label={t.addWorkHeading} load={loadWorks}
              onChange={chosen => { if (chosen) addSlide(blankSlide(taken(), { kind: 'work', work: workIri(chosen.id) })); }} />
            <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={() => setPickingWork(false)}>{t.cancel}</Button>
          </div> : <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" disabled={slides.length >= MAX_SLIDES} onClick={() => setPickingWork(true)}><PlusIcon aria-hidden="true" />{t.addWork}</Button>
            <Button type="button" variant="outline" disabled={slides.length >= MAX_SLIDES}
              onClick={() => addSlide(blankSlide(taken(), { kind: 'link', href: '' }))}><LinkIcon aria-hidden="true" />{t.addLink}</Button>
            {slides.length >= MAX_SLIDES ? <span className="text-muted-foreground text-sm">{t.addLimit}</span> : null}
          </div>}
        </section>

        {selectedSlide ? <section key={selectedSlide.key} aria-labelledby="zone-showcase-slide" className="grid gap-8 rounded-3xl border border-border/70 p-4 sm:p-6">
          <h3 id="zone-showcase-slide" className="font-semibold text-lg">
            {t.slideLabel({ index: String(slides.indexOf(selectedSlide) + 1) })} · {slideName(selectedSlide, worksOf(selectedSlide), locale, t)}</h3>
          <TargetFields slide={selectedSlide} work={worksOf(selectedSlide)}
            loading={selectedSlide.target.kind === 'work' && loadingWorks.has(selectedSlide.target.work)} locale={locale} pickerMessages={pickerMessages} loadWorks={loadWorks}
            problems={slideProblems(selectedSlide)} onTarget={target => updateSlide(selectedSlide.key, { target })}
            onPick={work => updateSlide(selectedSlide.key, { target: { kind: 'work', work } })} t={t} />
          <WordsFields slide={selectedSlide} locale={locale} problems={slideProblems(selectedSlide)} onChange={change => updateSlide(selectedSlide.key, change)} t={t} />
          <ScheduleFields slide={selectedSlide} problems={slideProblems(selectedSlide)} onChange={change => updateSlide(selectedSlide.key, change)} t={t} />
          <SlideArtPanels slide={selectedSlide} art={art} registry={registry} realm={realm} source={sources[selectedSlide.key] ?? 'none'} stage={selectedStage!}
            locale={locale} onAnchor={(slot, anchor) => setArt(selectedSlide.key, current => ({ ...current, [slot]: { ...current[slot]!, anchor } }))} t={t} e={e} />
        </section> : null}

        <TitleEffectField effect={effect} sample={sampleText} sampleLanguage={locale} onChange={setEffect} t={t} />
      </div>
      <div className="order-1 xl:sticky xl:top-20 xl:order-2">
        <ZonePreview slidesFor={reader => previewSlides({ slides, works, registry, drafts: art.drafts, framed: art.framed, reader })} effect={effect}
          locale={locale} t={t} e={e} />
      </div>
    </div>

    <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 grid gap-3 rounded-2xl border border-border/70 bg-card/95 p-3 shadow-(--aura-shadow-card) backdrop-blur sm:p-4 md:bottom-3">
      {status?.kind === 'saved' ? <Alert variant="success" role="status" className="py-2.5"><CircleCheckIcon aria-hidden="true" />
        <AlertDescription>{status.replayed ? t.savedReplayed : t.savedNotice}</AlertDescription></Alert> : null}
      {status?.kind === 'reloaded' ? <Alert variant="info" role="status" className="py-2.5"><RefreshCwIcon aria-hidden="true" />
        <AlertDescription>{t.reloaded(status.count)}</AlertDescription></Alert> : null}
      {status?.kind === 'reload-failed' ? <Alert variant="destructive" role="alert" className="py-2.5"><TriangleAlertIcon aria-hidden="true" />
        <AlertDescription>{t.reloadFailed}</AlertDescription></Alert> : null}
      {status?.kind === 'refused' ? <Alert variant="destructive" role="alert" className="py-2.5"><TriangleAlertIcon aria-hidden="true" />
        <AlertDescription className="grid gap-2">
          <span>{refusalText(status.refusal)}</span>
          {status.detail && status.refusal !== 'conflict' ? <span><span className="font-medium">{t.mainSays}:</span> {status.detail}</span> : null}
          {status.refusal === 'conflict' ? <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => void reload()}>
            <RefreshCwIcon aria-hidden="true" />{t.reloadLatest}</Button> : null}
        </AlertDescription></Alert> : null}
      {art.pending > 0 ? <p role="status" className="text-sm text-warning-foreground">{t.pendingImages(art.pending)}</p> : null}
      {heroNeeded && dirty ? <p className="text-muted-foreground text-sm">{t.needsModule}</p> : null}
      {invalid ? <p className="text-destructive text-sm">{t.fixProblems}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-medium text-sm">{dirty ? t.unsaved : t.allSaved}</span>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" disabled={saving || (!dirty && art.pending === 0)} onClick={discardAll}><Undo2Icon aria-hidden="true" />{t.discard}</Button>
          <Button type="button" disabled={!canSave} isLoading={saving} onClick={() => void saveAll()}>{saving ? t.saving : t.save}</Button>
        </div>
      </div>
    </div>
  </div>;
}
