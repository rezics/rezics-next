'use client';

import { cloneElement, isValidElement, useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import { realmManagementFrame } from '../../app/[locale]/manage/r/[realm]/layout.tsx';
import { realmZonesBody } from '../../app/[locale]/manage/r/[realm]/zones/page.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { getMessages } from '../../i18n/server.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { signInPath } from '../auth/paths.ts';
import { recordedManagementAgent } from '../realm/realm-membership-recorded-page.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import shellJa from '../shell/messages/ja.ts';
import { ManageFailure } from './parts.tsx';
import { realmHref } from './routes.ts';
import { attachmentIdentity, attachmentSelections, type AttachmentVisit } from './zone-attachments-recorded-page.ts';

/** Replay the admitted management route, including its actual Realm frame and session identity. */
export function ZoneAttachmentsRecordedPage({ record, persona, visit = 'inventory', loading = false, locale }: {
  record: AnswerRecord; persona: AnswerPersona; visit?: AttachmentVisit; loading?: boolean; locale: UiLocale;
}) {
  const [view, setView] = useState<ReactNode>(null);
  const [discrepancy, setDiscrepancy] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    const replay = recordedFetch(record, persona, attachmentSelections(record, persona, visit, loading), { pathPrefix: BFF_PREFIX, locale });
    const main = browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
    void (async () => {
      const { realm } = attachmentIdentity(record, persona);
      const signInHref = signInPath(localizedPath(realmHref(realm, 'zones'), locale));
      if (persona === 'visitor') {
        const messages = await getMessages('manage', locale);
        if (mounted) setView(<ManageFailure failure="sign-in" locale={locale} messages={messages} signInHref={signInHref} />);
        return;
      }
      const { agent, actingSubject } = await recordedManagementAgent(replay.fetcher, locale);
      const [page, frame] = await Promise.all([
        realmZonesBody({ principal: actingSubject, realm, actingSubject, main, locale, signInHref, client: () => main }),
        realmManagementFrame({ main, realm, address: realm, actingSubject, agent, locale, token: 'recorded', accessClient: main, children: null }),
      ]);
      if (!isValidElement(frame)) throw new Error('Management frame did not render');
      if (mounted) setView(cloneElement(frame, {}, page));
    })().catch(error => {
      if (mounted) setDiscrepancy(error instanceof Error ? error.message : String(error));
    });
    return () => { mounted = false; replay.dispose(); };
  }, [record, persona, visit, loading, locale]);
  if (discrepancy) return <p role="alert">{discrepancy}</p>;
  return view ?? <p role="status" aria-busy="true">{locale === 'ja' ? shellJa.loading : shellMessages.loading}</p>;
}
