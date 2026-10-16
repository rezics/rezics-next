'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { createReaderStore } from '../catalogue/reader-store.ts';
import { classificationFacet, facetLabel } from '../concept/facets.ts';
import { mainRelationships } from '../relationships/api.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { AdoptionRegion } from '../work-page/adoption.tsx';
import { AlsoEnjoyedSection } from '../work-page/also-enjoyed.tsx';
import { BooksContentsRecordedPage, type BooksContentsRecordedView } from '../work-page/books-contents-recorded-page.tsx';
import { ClassificationRegion } from '../work-page/classification.tsx';
import { WorkCredits } from '../work-page/credits.tsx';
import { messages } from '../work-page/messages.ts';
import { idOf, workHref } from '../work-page/route.ts';
import { WorkFrame } from '../work-page/work-frame.tsx';
import { copyOf } from './messages.ts';
import { MediumProgress } from './medium-progress.tsx';
import {
  mangaDeviceApi, mangaDeviceSelections, mangaFrameSelections, mangaRecordedClient, mangaRecordedTransport,
  mangaWorkId, readMangaDeviceFrame, readMangaPublicOpening, type MangaDevice, type MangaDevicePersona, type MangaDeviceState,
} from './manga-two-device-recorded-page.ts';

type Frame = Awaited<ReturnType<typeof readMangaDeviceFrame>>;
type Device = { device: MangaDevice; work: string; api: ReturnType<typeof mangaDeviceApi> };
const deviceNames = { first: 'First device', second: 'Second device · Omnibus' } as const;

/** The existing Work frame and progress controls, with one recorded transport per real own-device grant. */
export function MangaTwoDeviceRecordedPage({ persona, locale = 'en', state = 'undo', hold = false }: {
  persona: AnswerPersona; locale?: UiLocale; state?: MangaDeviceState; hold?: boolean;
}) {
  const [ready, setReady] = useState<{ frame: Frame; devices: Device[]; main: ReturnType<typeof mangaRecordedClient>;
    fetcher: typeof fetch; publicOpening: BooksContentsRecordedView | null } | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    const disposals: (() => void)[] = [];
    setReady(null);
    setFault(null);
    const fail = (error: unknown) => {
      if (mounted && !(error instanceof DOMException && error.name === 'AbortError')) setFault(String(error));
    };
    const frameReplay = mangaRecordedTransport(persona, mangaFrameSelections(persona), { onError: fail });
    disposals.push(frameReplay.dispose);
    const main = mangaRecordedClient(frameReplay.fetcher, persona, window.location.origin);
    void (async () => {
      const [frame, publicOpening] = await Promise.all([readMangaDeviceFrame(main, persona),
        persona === 'visitor' ? readMangaPublicOpening(main, persona, locale) : Promise.resolve(null)]);
      if (!mounted) return;
      if (!frame.header.ok) throw new Error(`Work header: ${frame.header.failure}`);
      const devices: Device[] = persona === 'visitor' ? [] : (state === 'replay' ? ['first'] as const : ['first', 'second'] as const)
        .map(device => {
          const replay = mangaRecordedTransport(persona, mangaDeviceSelections(device, state, hold && device === 'second'), {
            loseAnswer: state === 'replay', onError: fail,
          });
          disposals.push(replay.dispose);
          const client = mangaRecordedClient(replay.fetcher, persona, window.location.origin);
          return { device, work: `https://rezics.com/id/${mangaWorkId(persona, device)}`,
            api: mangaDeviceApi(client, persona as MangaDevicePersona) };
        });
      setReady({ frame, devices, main, fetcher: frameReplay.fetcher, publicOpening });
    })().catch(fail);
    return () => { mounted = false; for (const dispose of disposals) dispose(); };
  }, [persona, locale, state, hold]);
  const actions = useMemo(() => ready?.frame.actingSubject && ready.frame.seed
    ? createReaderStore({ actingSubject: ready.frame.actingSubject, seed: ready.frame.seed, main: () => ready.main }) : undefined, [ready]);
  const relationships = useMemo(() => ready?.frame.actingSubject ? mainRelationships(ready.frame.actingSubject, {
    origin: `${window.location.origin}${BFF_PREFIX}`, fetch: ready.fetcher,
  }) : undefined, [ready]);
  const frame = ready?.frame, header = frame?.header.ok ? frame.header.data : null;
  const t = messages[locale];
  const facet = frame?.facets.ok ? classificationFacet(frame.facets.data) : null;
  const view = { workRef: mangaWorkId(persona), scope: { kind: 'global' as const }, realms: frame?.adoptions.ok
    ? frame.adoptions.data.items.flatMap(item => {
      const id = idOf(item.realm); return id ? [{ id, name: item.name }] : [];
    }) : [] };
  return <div className="grid min-w-0 gap-3" lang={locale}>
    <div className="px-4 pt-4 sm:px-6">
      <p lang="en" className="text-sm">{persona[0]!.toUpperCase() + persona.slice(1)}</p>
      {frame?.actingSubject ? <p className="break-all font-mono text-xs">{frame.actingSubject}</p> : null}
    </div>
    {fault ? <pre role="alert" className="whitespace-pre-wrap break-words p-4">{fault}</pre> : null}
    {ready && frame && header ? <WorkFrame workRef={view.workRef} work={header} locale={locale} messages={t}
      signedIn={persona !== 'visitor'} actingSubject={frame.actingSubject} readerSeed={frame.seed ?? undefined}
      readerActions={actions} relationships={relationships}
      signInHref={signInPath(localizedPath(workHref(view.workRef), locale))}
      credits={<WorkCredits agentCredits={frame.agentCredits} credits={frame.credits} locale={locale} messages={t} />}>
      <ClassificationRegion classifications={frame.classifications} view={view}
        facet={facet ? { id: facet.id, label: facetLabel(facet, locale) } : null} locale={locale} messages={t} />
      <AlsoEnjoyedSection alsoEnjoyed={frame.alsoEnjoyed} book realms={view.realms} locale={locale} messages={t} />
      <AdoptionRegion adoptions={frame.adoptions} view={view} locale={locale} messages={t} />
      {ready.publicOpening ? <BooksContentsRecordedPage view={ready.publicOpening} locale={locale} messages={t} /> : null}
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        {ready.devices.map(({ device, work, api }) => <section key={device} aria-label={deviceNames[device]} className="min-w-0">
          <h2 lang="en" className="mb-3 font-medium text-sm">{deviceNames[device]}</h2>
          <MediumProgress work={work} api={api} episodes={null}
            t={{ ...copyOf(locale), chapters: `${deviceNames[device]} · ${copyOf(locale).chapters}` }} />
        </section>)}
      </div>
    </WorkFrame> : fault ? null : <p role="status" className="p-4">{t.loading}</p>}
  </div>;
}
