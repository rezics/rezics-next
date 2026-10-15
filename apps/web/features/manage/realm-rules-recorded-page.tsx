'use client';

import { useEffect, useRef, useState } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import type { MainClient } from '../discover/types.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import shellJa from '../shell/messages/ja.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { bffAdminApi, type AdminApi } from './admin-api.ts';
import { saveSettings } from './commands.ts';
import { messages as manageMessages, type ManageMessages } from './messages.ts';
import manageDe from './messages/de.ts';
import manageEs from './messages/es.ts';
import manageFr from './messages/fr.ts';
import manageJa from './messages/ja.ts';
import manageKo from './messages/ko.ts';
import manageZhHans from './messages/zh-Hans.ts';
import manageZhHant from './messages/zh-Hant.ts';
import { RealmFrame } from './realm-frame.tsx';
import { readAgents, readRealmHeader, readSettings } from './read.ts';
import { recoveryIndexKey } from './safety-pending.ts';
import { SettingsView } from './settings-view.tsx';
import type { RealmHeader, SettingsView as Settings } from './types.ts';

const manageOverlays = new Map<UiLocale, Partial<ManageMessages>>([
  ['zh-Hant', manageZhHant], ['zh-Hans', manageZhHans], ['ja', manageJa], ['ko', manageKo],
  ['de', manageDe], ['fr', manageFr], ['es', manageEs],
]);

/**
 * The settings factory builds its own host client. This binds the same settings
 * read and command to the client the page was given, and leaves every other
 * management call on the host factory.
 */
function settingsApi(client: MainClient, realm: string, actingSubject: string): AdminApi {
  const host = bffAdminApi(realm, actingSubject);
  return {
    ...host,
    settings: () => readSettings(client, realm, actingSubject),
    saveSettings: (command, key) => saveSettings(client, realm, command, key),
  };
}

interface LoadedSettings {
  header: RealmHeader | null;
  settings: Settings;
  agent: AgentOption;
  api: AdminApi;
}

/**
 * The manage settings route's rules reader and command. The realm and acting
 * person are the route parameters. Selections only choose recorded answers for
 * the requests those production functions make.
 */
export function RealmRulesRecordedPage({ record, persona, selections, locale, realm, actingSubject, principal }: {
  record: AnswerRecord; persona: AnswerPersona; selections: readonly RecordedSelection[]; locale: UiLocale;
  realm: string; actingSubject: string; principal: string;
}) {
  const [load, setLoad] = useState<LoadedSettings | { error: string } | null>(null);
  const prepared = useRef(false);
  if (!prepared.current) {
    prepared.current = true;
    try { localStorage.removeItem(recoveryIndexKey(principal, realm)); } catch { /* private mode */ }
  }
  useEffect(() => {
    let mounted = true;
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX, locale });
    const client = browserMainApi(window.location.origin, { anonymous: false, fetcher: replay.fetcher });
    void Promise.all([
      readRealmHeader(client, realm, locale, actingSubject),
      readSettings(client, realm, actingSubject),
      readAgents(client, [actingSubject], actingSubject),
    ]).then(([header, settings, names]) => {
      if (!mounted) return;
      if (!settings.ok) {
        setLoad({ error: settings.problem?.title ?? settings.failure });
        return;
      }
      const named = names[actingSubject];
      setLoad({
        header: header.ok ? header.data : null,
        settings: settings.data,
        agent: {
          iri: actingSubject,
          label: named?.label ?? null,
          handle: named?.handle ?? null,
          kind: null,
          path: null,
        },
        api: settingsApi(client, realm, actingSubject),
      });
    }).catch((error: unknown) => {
      if (!mounted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setLoad({ error: error instanceof Error ? error.message : String(error) });
    });
    return () => { mounted = false; replay.dispose(); };
  }, [record, persona, selections, locale, realm, actingSubject]);
  if (!load) return <p role="status" aria-busy="true">{locale === 'ja' ? shellJa.loading : shellMessages.loading}</p>;
  if ('error' in load) return <p role="alert">{load.error}</p>;
  const messages = { ...manageMessages, ...manageOverlays.get(locale) };
  return <RealmFrame realm={realm} header={load.header} agent={load.agent} locale={locale} messages={messages} settingsAllowed>
    <SettingsView principal={principal} realm={realm} actingSubject={actingSubject} initial={load.settings}
      locale={locale} messages={messages} api={load.api} />
  </RealmFrame>;
}
