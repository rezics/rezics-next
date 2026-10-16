'use client';

import { useEffect, useState, type ReactNode, type MouseEvent } from 'react';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import { StoryRouteContext } from '../../.storybook/next-navigation.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { addressKey } from '../address/path.ts';
import type { CanonicalAddress } from '@rezics/model/address';
import { browserMainApi } from '../api/browser.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import { readZoneManagementFrame } from '../zone-editor/authoring-reads.ts';
import { zoneEditorDraftKey } from '../zone-editor/draft-state.ts';
import { zoneRealmPath } from '../zone-editor/routes.ts';
import { zoneManagementShell } from '../zones/independent-zone-recorded-page-routes.tsx';
import { CreateCommunityPage } from './create-page.tsx';
import { zoneRealmAttachmentView } from './realm-site-creation-attachment.tsx';
import type { RealmSiteCreationIntent } from './realm-site-creation-api.ts';

/** Navigation harness only: both destinations use their production composition, readers and controls. */
export function RealmSiteCreationRecordedPage({ record, locale, existing = false }: {
  record: AnswerRecord;
  locale: UiLocale;
  existing?: boolean;
}) {
  const sample = (label: string) => record.personas.owner.find(item => item.label === label)!;
  const intent = sample('creation-space').body as RealmSiteCreationIntent;
  const address = sample('creation-address').answer as { canonical: CanonicalAddress };
  const space = addressKey(address.canonical);
  const destination = localizedPath(zoneRealmPath(space), locale);
  const [view, setView] = useState<ReactNode>(null);
  const [opened, setOpened] = useState(existing);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!opened) return;
    let active = true;
    async function open() {
      const sample = (label: string) => record.personas.owner.find(item => item.label === label)!;
      const intent = sample('creation-space').body as RealmSiteCreationIntent;
      const address = sample('creation-address').answer as { canonical: CanonicalAddress };
      const space = addressKey(address.canonical);
      const main = browserMainApi();
      const anonymous = browserMainApi(undefined, { anonymous: true });
      const created = sample('creation-space').answer as { zone: string };
      sessionStorage.removeItem(zoneEditorDraftKey(created.zone.slice(-36), intent.actingSubject, 'attachment'));
      const frame = await readZoneManagementFrame(main, space, locale, intent.actingSubject);
      const content = await zoneRealmAttachmentView({ main, anonymous, locale, actingSubject: intent.actingSubject,
        signInHref: localizedPath('/sign-in', locale), loadAuthoring: async () => frame.authoring });
      const profile = sample('page-agent-profile').answer as { id: string; displayName: string };
      if (profile.id !== intent.actingSubject) throw new Error('Recorded identity differs from the command actor');
      if (active) setView(zoneManagementShell({ space, frame, locale, actingSubject: intent.actingSubject,
        agent: { iri: profile.id, label: profile.displayName, handle: null, kind: 'person', path: 'direct-principal' },
        manageMessages: manageMessages[locale], children: content }));
    }
    void open().catch(value => { if (active) setError(value); });
    return () => { active = false; };
  }, [opened, record, locale]);

  if (error) throw error;

  function navigate(event: MouseEvent<HTMLDivElement>) {
    const link = (event.target as HTMLElement).closest('a');
    if (!link || new URL(link.href).pathname !== destination) return;
    event.preventDefault();
    setOpened(true);
  }

  return <StoryRouteContext value={{ pathname: opened ? destination : localizedPath('/r/new', locale) }}>
    <div onClick={navigate}>{opened ? view : <CreateCommunityPage locale={locale} signedIn actingSubject={intent.actingSubject} />}</div>
  </StoryRouteContext>;
}
