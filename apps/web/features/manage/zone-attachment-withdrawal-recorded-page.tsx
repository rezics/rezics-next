'use client';

import { cloneElement, isValidElement, useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import { realmManagementFrame } from '../../app/[locale]/manage/r/[realm]/layout.tsx';
import { realmZonesBody } from '../../app/[locale]/manage/r/[realm]/zones/page.tsx';
import { zoneManagementShell } from '../../app/[locale]/manage/z/[space]/layout.tsx';
import { zoneRealmAttachmentView } from '../../app/[locale]/manage/z/[space]/realm/page.tsx';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { browserMainApi } from '../api/browser.ts';
import { RouteLoading } from '../shell/route-states.tsx';
import { browserZoneRealmAttachment } from '../zone-editor/api.ts';
import { readZoneManagementFrame } from '../zone-editor/authoring-reads.ts';
import { zoneRealmPath } from '../zone-editor/routes.ts';
import { messages } from './messages.ts';
import { settle } from './read.ts';
import { realmHref } from './routes.ts';
import { manager } from './server.ts';
import { withdrawalReplay, type WithdrawalSurface } from './zone-attachment-withdrawal-recorded-page.ts';

/** Both production bodies and frames consume the injected typed client, including commands and admission reads. */
export function ZoneAttachmentWithdrawalRecordedPage({ record, persona, surface = 'realm', loading = false }: {
  record: AnswerRecord; persona: AnswerPersona; surface?: WithdrawalSurface; loading?: boolean;
}) {
  const [view, setView] = useState<ReactNode>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setView(null); setProblem(null);
    // Both management routes authenticate before reading Main. No visitor answers are needed.
    if (persona === 'visitor') {
      const sample = record.personas.owner.find(item => item.label === (surface === 'zone' ? 'zone-configuration' : 'realm-attachments'))!;
      const id = new URL(sample.path, 'https://recorded.invalid').pathname.split('/')[3]!;
      const href = surface === 'zone' ? zoneRealmPath(id) : realmHref(id, 'zones');
      const previous = globalThis.fetch;
      globalThis.fetch = (async () => { throw new Error('Signed-out management sent an API request'); }) as unknown as typeof fetch;
      void manager('en', href).then(() => { if (active) setProblem('Signed-out management admitted a visitor'); })
        .catch((error: unknown) => { if (active) setView(<p role="status">{String(error)}</p>); });
      return () => { active = false; globalThis.fetch = previous; };
    }
    const replay = withdrawalReplay(record, persona, surface, loading);
    const previous = globalThis.fetch;
    // The Realm frame's request-cached token client uses fetch, just as it does on the server.
    globalThis.fetch = replay.fetcher;
    void (async () => {
      const { agent, actingSubject } = await replay.session();
      const { main, coordinate } = replay;
      let page: ReactNode;
      if (surface === 'zone') {
        const frame = await readZoneManagementFrame(main, coordinate, 'en', actingSubject);
        const anonymous = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: replay.fetcher });
        const body = await zoneRealmAttachmentView({ main, actingSubject, locale: 'en',
          signInHref: signInPath(localizedPath(zoneRealmPath(coordinate), 'en')),
          loadAuthoring: async () => frame.authoring,
          readRealm: realm => settle(() => anonymous.v1.realms({ realm: realm.slice(-36) }).get({ query: {} })),
          api: browserZoneRealmAttachment(main) });
        page = zoneManagementShell({ space: coordinate, frame, agent, actingSubject, locale: 'en', manageMessages: messages, children: body });
      } else {
        const [body, frame] = await Promise.all([
          realmZonesBody({ principal: actingSubject, realm: coordinate, actingSubject, main, locale: 'en',
            signInHref: signInPath(localizedPath(realmHref(coordinate, 'zones'), 'en')), client: () => main }),
          realmManagementFrame({ main, realm: coordinate, address: coordinate, actingSubject, agent, locale: 'en',
            token: 'recorded', accessClient: main, children: null }),
        ]);
        if (!isValidElement(frame)) throw new Error('Realm management frame is absent');
        page = cloneElement(frame, {}, body);
      }
      if (active) setView(page);
    })().catch((error: unknown) => { if (active) setProblem(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; globalThis.fetch = previous; replay.dispose(); };
  }, [record, persona, surface, loading]);
  if (problem) return <p role="alert">{problem}</p>;
  return view ?? <RouteLoading />;
}
