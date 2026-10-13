'use client';

import { useEffect, useState } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import progressRecord from '../../../../tests/qa/fixtures/outcomes/anime/continue-progress-across-devices-two-device-progress.json';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import type { Loaded } from '../feed/types.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { WorkCredits } from '../work-page/credits.tsx';
import { messages as workMessages } from '../work-page/messages.ts';
import { WorkHeader } from '../work-page/work-header.tsx';
import type { AgentCreditPage, CreditPage, WorkHeader as Header } from '../work-page/types.ts';
import {
  animeTwoDeviceClient,
  animeTwoDeviceEpisodes,
  animeTwoDeviceHeaderSelections,
  animeTwoDeviceSelections,
  isSignedInPersona,
  readAnimeTwoDeviceCredits,
  readAnimeTwoDeviceHeader,
  recordedActingSubject,
  recordedWorkId,
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
  devices: { name: (typeof deviceName)[keyof typeof deviceName]; api: EpisodeApi }[];
}

/** The recorded Work, its author, and the two devices' episode controls. */
export function AnimeTwoDeviceRecordedPage({
  persona,
  locale = 'en',
  hold = false,
}: {
  persona: AnswerPersona;
  locale?: UiLocale;
  hold?: boolean;
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
    const fetcherFor = (selections: readonly RecordedSelection[]) => {
      const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
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
    const main = animeTwoDeviceClient(
      fetcherFor(animeTwoDeviceHeaderSelections()),
      persona === 'visitor',
      window.location.origin,
    );
    void (async () => {
      const header = await readAnimeTwoDeviceHeader(main, id, actingSubject);
      if (!mounted) return;
      if (!header.ok) {
        fail(new Error(`Work header: ${header.failure}`));
        return;
      }
      const [agentCredits, credits] = await readAnimeTwoDeviceCredits(main, id, actingSubject);
      if (!mounted) return;
      const devices =
        isSignedInPersona(persona) && actingSubject
          ? (['first', 'second'] as const).map((device) => {
              const deviceMain = animeTwoDeviceClient(
                fetcherFor(animeTwoDeviceSelections(persona, device, hold && device === 'second')),
                false,
                window.location.origin,
              );
              return {
                name: deviceName[device],
                api: animeTwoDeviceEpisodes(actingSubject, deviceMain),
              };
            })
          : [];
      setReady({ header: header.data, actingSubject, agentCredits, credits, devices });
    })().catch(fail);
    return () => {
      mounted = false;
      for (const dispose of disposals) dispose();
    };
  }, [persona, hold]);

  const page = workMessages[locale];
  const episodes = copyOf(locale);
  return (
    <main className="mx-auto grid min-w-0 max-w-5xl gap-6 px-4 py-6" lang={locale}>
      {fault ? (
        <pre role="alert" className="whitespace-pre-wrap break-words">
          {fault}
        </pre>
      ) : null}
      <p className="text-sm">{personaName[persona]}</p>
      {ready?.actingSubject ? (
        <p className="break-all font-mono text-xs">{ready.actingSubject}</p>
      ) : null}
      {ready ? (
        <>
          <WorkHeader
            work={ready.header}
            locale={locale}
            messages={page}
            credits={
              <WorkCredits
                agentCredits={ready.agentCredits}
                credits={ready.credits}
                locale={locale}
                messages={page}
              />
            }
          />
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
        </>
      ) : (
        <p role="status">{page.loading}</p>
      )}
    </main>
  );
}
