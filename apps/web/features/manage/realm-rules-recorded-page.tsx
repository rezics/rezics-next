import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import { realmManagementFrame } from '../../app/[locale]/manage/r/[realm]/layout.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { getMessages } from '../../i18n/server.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { signInPath } from '../auth/paths.ts';
import { RealmRulesRoute } from '../realm/routes.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import shellJa from '../shell/messages/ja.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { bffAdminApi } from './admin-api.ts';
import { readAgents } from './read.ts';
import { rulesPageClient } from './realm-rules-recorded-page-client.ts';
import { readRealmRulesSettings } from './realm-rules-recorded-page.ts';
import { RealmRulesSettings } from './realm-rules-recorded-page-settings.tsx';
import { recoveryIndexKey } from './safety-pending.ts';
import { spaceAccessApi } from './settings-api.ts';

/** Only transport and host request inputs differ from the production routes. */
export function RealmRulesRecordedPage({ record, persona, selections, locale, realm, actingSubject, principal,
  page = 'settings' }: {
  record: AnswerRecord; persona: AnswerPersona; selections: readonly RecordedSelection[]; locale: UiLocale;
  realm: string; actingSubject: string; principal: string; page?: 'settings' | 'rules';
}) {
  const [view, setView] = useState<ReactNode>(null);
  const [error, setError] = useState<Error | null>(null);
  const prepared = useRef(false);
  if (!prepared.current) {
    prepared.current = true;
    try { localStorage.removeItem(recoveryIndexKey(principal, realm)); } catch { /* private mode */ }
  }
  useEffect(() => {
    let mounted = true;
    setView(null); setError(null);
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX, locale });
    const fetcher = (async (input, init) => {
      try { return await replay.fetcher(input, init); }
      catch (failure) {
        if (mounted && !(failure instanceof DOMException && failure.name === 'AbortError')) {
          setError(failure instanceof Error ? failure : new Error(String(failure)));
        }
        throw failure;
      }
    }) as typeof fetch;
    const clients = rulesPageClient(fetcher, actingSubject || undefined);
    const main = clients.personal ?? clients.main;
    async function render() {
      if (page === 'rules') return RealmRulesRoute({ params: Promise.resolve({ locale, realm }),
        searchParams: Promise.resolve({}) }, clients);
      const [loaded, messages, names] = await Promise.all([
        readRealmRulesSettings(main, realm, actingSubject), getMessages('manage', locale),
        readAgents(main, [actingSubject], actingSubject),
      ]);
      const named = names[actingSubject];
      return realmManagementFrame({ main, realm, address: realm, actingSubject,
        agent: { iri: actingSubject, label: named?.label ?? null, handle: named?.handle ?? null, kind: null, path: null },
        locale, accessClient: main,
        children: <RealmRulesSettings loaded={loaded} principal={principal} actingSubject={actingSubject} address={realm}
          locale={locale} messages={messages} signInHref={signInPath(`/${locale}/manage/r/${realm}/settings`)}
          api={bffAdminApi(realm, actingSubject, () => main)}
          accessApi={loaded.kind === 'settings' ? spaceAccessApi(() => main, loaded.access.space, loaded.access.realm, actingSubject) : undefined} />,
      });
    }
    void render().then(result => { if (mounted) setView(result); }).catch((failure: unknown) => {
      if (!mounted || (failure instanceof DOMException && failure.name === 'AbortError')) return;
      setError(failure instanceof Error ? failure : new Error(String(failure)));
    });
    return () => { mounted = false; replay.dispose(); };
  }, [record, persona, selections, locale, realm, actingSubject, principal, page]);
  if (error) throw error;
  return view ?? <p role="status" aria-busy="true">{locale === 'ja' ? shellJa.loading : shellMessages.loading}</p>;
}
