'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import progressRecord from '../../../../tests/qa/fixtures/outcomes/anime/continue-progress-across-devices-two-device-progress.json';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { signInPath } from '../auth/paths.ts';
import { coverKindOf } from '../catalogue/work.ts';
import { classificationFacet, facetLabel } from '../concept/facets.ts';
import type { FacetList } from '../concept/types.ts';
import { mainRelationships } from '../relationships/api.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { AdoptionRegion } from '../work-page/adoption.tsx';
import { AlsoEnjoyedSection } from '../work-page/also-enjoyed.tsx';
import { ClassificationRegion } from '../work-page/classification.tsx';
import { WorkCredits } from '../work-page/credits.tsx';
import { messages as workMessages } from '../work-page/messages.ts';
import { idOf, workHref } from '../work-page/route.ts';
import type { ScopeRealm, ScopeView } from '../work-page/scope-bar.tsx';
import type {
  AdoptionPage,
  AgentCreditPage,
  AlsoEnjoyedPage,
  ClassificationPage,
  CreditPage,
  Loaded,
  WorkHeader as Header,
} from '../work-page/types.ts';
import { WorkFrame } from '../work-page/work-frame.tsx';
import {
  animeTwoDeviceChainSelections,
  animeTwoDeviceClient,
  animeTwoDeviceEpisodes,
  animeTwoDeviceFrameSelections,
  isSignedInPersona,
  readAnimeTwoDeviceFrame,
  recordedActingSubject,
  recordedWorkId,
  sequencedRecordedFetch,
  type AnimeChain,
  type AnimeChainSelection,
} from './anime-two-device-recorded-page.ts';
import type { EpisodeApi } from './episode-api.ts';
import { EpisodeProgress } from './episode-progress.tsx';
import { copyOf } from './messages.ts';

const record = progressRecord as AnswerRecord;
const personaName: Record<AnswerPersona, string> = {
  visitor: 'Visitor',
  stranger: 'Stranger',
  member: 'Member',
  owner: 'Owner',
  moderator: 'Moderator',
  operator: 'Operator',
};
const deviceName = { first: 'First device', second: 'Second device' } as const;

interface Ready {
  header: Header;
  actingSubject?: string;
  agentCredits: Loaded<AgentCreditPage>;
  credits: Loaded<CreditPage>;
  classifications: Loaded<ClassificationPage>;
  facets: Loaded<FacetList>;
  alsoEnjoyed: Loaded<AlsoEnjoyedPage>;
  adoptions: Loaded<AdoptionPage>;
  devices: { name: (typeof deviceName)[keyof typeof deviceName]; api: EpisodeApi }[];
  frameFetcher: typeof fetch;
}

function realmsOf(adoptions: Loaded<AdoptionPage>): ScopeRealm[] {
  if (!adoptions.ok) return [];
  return adoptions.data.items.flatMap((item) => {
    const realm = idOf(item.realm);
    return realm ? [{ id: realm, name: item.name }] : [];
  });
}

/** The recorded Work page, opened through its production frame, and each own-device episode control. */
export function AnimeTwoDeviceRecordedPage({
  persona,
  locale = 'en',
  hold = false,
  direction = 'mark',
}: {
  persona: AnswerPersona;
  locale?: UiLocale;
  hold?: boolean;
  /** Which recorded chain the two devices replay. Mark completes; clear removes that completion. */
  direction?: AnimeChain;
}) {
  const [ready, setReady] = useState<Ready | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  useEffect(() => {
    const disposals: (() => void)[] = [];
    let mounted = true;
    const fail = (error: unknown) => {
      if (!mounted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setFault(error instanceof Error ? error.message : String(error));
    };
    const fetcherFor = (selections: readonly RecordedSelection[], sequenced = false) => {
      const replay = sequenced
        ? sequencedRecordedFetch(persona, selections as readonly AnimeChainSelection[], { pathPrefix: BFF_PREFIX })
        : recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
      disposals.push(replay.dispose);
      return (async (input: RequestInfo | URL, init?: RequestInit) => {
        try {
          return await replay.fetcher(input, init);
        } catch (error) {
          fail(error);
          throw error;
        }
      }) as typeof fetch;
    };
    const actingSubject = recordedActingSubject(persona);
    const id = recordedWorkId(persona);
    const frameFetcher = fetcherFor(animeTwoDeviceFrameSelections(persona));
    const main = animeTwoDeviceClient(frameFetcher, persona === 'visitor', window.location.origin);
    void (async () => {
      const [header, agentCredits, credits, classifications, facets, alsoEnjoyed, adoptions] =
        await readAnimeTwoDeviceFrame(main, id, actingSubject);
      if (!mounted) return;
      if (!header.ok) {
        fail(new Error(`Work header: ${header.failure}`));
        return;
      }
      const devices =
        isSignedInPersona(persona) && actingSubject
          ? (['first', 'second'] as const).map((device) => {
              const deviceMain = animeTwoDeviceClient(
                fetcherFor(
                  animeTwoDeviceChainSelections(device, direction, hold && device === 'second'),
                  true,
                ),
                false,
                window.location.origin,
              );
              return {
                name: deviceName[device],
                api: animeTwoDeviceEpisodes(actingSubject, deviceMain),
              };
            })
          : [];
      setReady({
        header: header.data,
        actingSubject,
        agentCredits,
        credits,
        classifications,
        facets,
        alsoEnjoyed,
        adoptions,
        devices,
        frameFetcher,
      });
    })().catch(fail);
    return () => {
      mounted = false;
      for (const dispose of disposals) dispose();
    };
  }, [persona, hold, direction]);

  const relationships = useMemo(
    () => ready?.actingSubject
      ? mainRelationships(ready.actingSubject, { origin: window.location.origin, fetch: ready.frameFetcher })
      : undefined,
    [ready],
  );
  const page = workMessages[locale];
  const episodes = copyOf(locale);
  const view: ScopeView | null = ready
    ? { workRef: recordedWorkId(persona), scope: { kind: 'global' }, realms: realmsOf(ready.adoptions) }
    : null;
  const facet = ready?.facets.ok ? classificationFacet(ready.facets.data) : null;
  return (
    <div className="grid min-w-0 gap-3" lang={locale}>
      {fault ? (
        <pre role="alert" className="whitespace-pre-wrap break-words">
          {fault}
        </pre>
      ) : null}
      <div className="px-4 pt-4 sm:px-6">
        <p className="text-sm">{personaName[persona]}</p>
        {ready?.actingSubject ? (
          <p className="break-all font-mono text-xs">{ready.actingSubject}</p>
        ) : null}
      </div>
      {ready && view ? (
        <WorkFrame
          workRef={view.workRef}
          work={ready.header}
          locale={locale}
          messages={page}
          signedIn={Boolean(ready.actingSubject)}
          actingSubject={ready.actingSubject}
          relationships={relationships}
          readerActions={ready.actingSubject ? { kind: 'unavailable' } : undefined}
          signInHref={signInPath(localizedPath(workHref(view.workRef), locale))}
          credits={
            <WorkCredits
              agentCredits={ready.agentCredits}
              credits={ready.credits}
              locale={locale}
              messages={page}
            />
          }
        >
          <ClassificationRegion
            classifications={ready.classifications}
            view={view}
            facet={facet ? { id: facet.id, label: facetLabel(facet, locale) } : null}
            locale={locale}
            messages={page}
          />
          <AlsoEnjoyedSection
            alsoEnjoyed={ready.alsoEnjoyed}
            book={coverKindOf(ready.header.types) === 'book'}
            realms={view.realms}
            locale={locale}
            messages={page}
          />
          <AdoptionRegion adoptions={ready.adoptions} view={view} locale={locale} messages={page} />
          {ready.devices.length ? (
            <div className="grid min-w-0 gap-6 lg:grid-cols-2">
              {ready.devices.map((device) => (
                <div key={device.name} className="min-w-0">
                  <h2 className="mb-3 font-medium text-sm">{device.name}</h2>
                  <EpisodeProgress
                    work={ready.header.id}
                    api={device.api}
                    t={episodes}
                    region={device.name}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </WorkFrame>
      ) : fault ? null : (
        <p role="status" className="px-4 sm:px-6">{page.loading}</p>
      )}
    </div>
  );
}
