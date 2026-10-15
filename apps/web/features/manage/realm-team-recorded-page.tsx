'use client';

import { cloneElement, isValidElement, useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { realmManagementFrame } from '../../app/[locale]/manage/r/[realm]/layout.tsx';
import { realmMembersBody } from '../../app/[locale]/manage/r/[realm]/members/page.tsx';
import { realmRolesBody } from '../../app/[locale]/manage/r/[realm]/roles/page.tsx';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { signInPath } from '../auth/paths.ts';
import { recordedManagementAgent } from '../realm/realm-membership-recorded-page.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import shellJa from '../shell/messages/ja.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { adminApi } from './admin-api.ts';
import { recoveryIndexKey } from './safety-pending.ts';
import { realmHref } from './routes.ts';

const recordedOrigin = 'https://recorded.invalid';

/**
 * Roles and members through the management route. The session, frame and page
 * readers are the production ones; selections only choose which recorded answer
 * each of their requests receives. A visitor is redirected before this layout,
 * so this page does not draw one.
 */
export function RealmTeamRecordedPage({ record, persona, selections, surface, locale, realm, actingSubject,
  sequence = false, now }: {
  record: AnswerRecord;
  persona: AnswerPersona;
  selections: readonly RecordedSelection[];
  surface: 'roles' | 'members';
  locale: UiLocale;
  realm: string;
  actingSubject: string;
  /** Repeated refreshes of one request advance through their recorded answers. */
  sequence?: boolean;
  /** Clock passed to the members route. The dialog keeps the later of this and Date.now(). */
  now?: number;
}) {
  const [view, setView] = useState<ReactNode>(null);
  const [discrepancy, setDiscrepancy] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    const realNow = Date.now;
    if (now !== undefined) Date.now = () => now;
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX, sequence, locale });
    const fetcher = replay.fetcher;
    const main = browserMainApi(recordedOrigin, { fetcher });
    const anonymous = browserMainApi(recordedOrigin, { anonymous: true, fetcher });
    const fail = (error: unknown) => {
      if (!mounted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setView(null);
      setDiscrepancy(error instanceof Error ? error.message : String(error));
    };
    void (async () => {
      const session = await recordedManagementAgent(fetcher, locale);
      if (session.actingSubject !== actingSubject) {
        throw new Error(`Session agent ${session.actingSubject} is not the route actor`);
      }
      try { localStorage.removeItem(recoveryIndexKey(session.actingSubject, realm)); } catch { /* private mode */ }
      const signInHref = signInPath(localizedPath(realmHref(realm, surface), locale));
      const api = adminApi(() => main, realm, session.actingSubject);
      const shared = {
        main, anonymous, principal: session.actingSubject, realm, actingSubject: session.actingSubject, locale, signInHref, api,
      };
      const body = surface === 'roles' ? realmRolesBody(shared) : realmMembersBody({ ...shared, now });
      // Layout and page read together, as they do on the route. The frame element is filled once the page resolves.
      const frame = realmManagementFrame({
        main, realm, address: realm, actingSubject: session.actingSubject, agent: session.agent, locale,
        token: 'recorded', children: null,
      });
      const [page, shell] = await Promise.all([body, frame]);
      if (!mounted) return;
      if (!isValidElement(shell)) throw new Error('Management frame did not render');
      setDiscrepancy(null);
      setView(cloneElement(shell, {}, page));
    })().catch(fail);
    return () => { mounted = false; Date.now = realNow; replay.dispose(); };
  }, [record, persona, selections, surface, locale, realm, actingSubject, sequence, now]);
  if (discrepancy) return <p role="alert">{discrepancy}</p>;
  if (!view) return <p role="status" aria-busy="true">{locale === 'ja' ? shellJa.loading : shellMessages.loading}</p>;
  return view;
}
