import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import type { UiLocale } from '../../i18n/define.ts';
import { settle } from '../manage/read.ts';
import type { MainClient, Loaded, RealmHeader } from '../manage/types.ts';
import type { ZoneRealmAttachmentClient } from '../zone-editor/api.ts';
import type { ZoneAuthoringLoad } from '../zone-editor/authoring-reads.ts';
import { messages } from '../zone-editor/messages.ts';
import { RealmAttachmentEditor } from '../zone-editor/realm-attachment.tsx';
import { ZoneAuthoringFailure } from '../zone-editor/states.tsx';

const realmIri = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** The Realm route's reader-to-controls composition; callers retain their production clients and cached authoring read. */
export async function zoneRealmAttachmentView({ main, readRealm, actingSubject, locale, signInHref, loadAuthoring, api }: {
  main: MainClient;
  readRealm: (realm: string) => Promise<Loaded<RealmHeader>>;
  actingSubject: string;
  locale: UiLocale;
  signInHref: string;
  loadAuthoring: () => Promise<ZoneAuthoringLoad>;
  api?: ZoneRealmAttachmentClient;
}): Promise<ReactNode> {
  const copy = messages[locale];
  const loaded = await loadAuthoring();
  if (loaded.kind === 'missing') notFound();
  if (loaded.kind === 'failure') return <ZoneAuthoringFailure failure={loaded.failure} copy={copy} />;
  const read = await settle(() => main.v1.zones({ id: loaded.model.zoneId }).configuration.get({ query: { actingSubject } }),
    { management: true });
  if (!read.ok) return <ZoneAuthoringFailure failure={read.failure} copy={copy} />;
  const revision = read.data.revision;
  const realm = configurationRealm(read.data.configuration);
  if (!revision) return <ZoneAuthoringFailure failure="unavailable" copy={copy} />;
  const named = realm ? await readRealm(realm) : null;
  const name = named?.ok ? realmName(named.data) : null;
  return <RealmAttachmentEditor zoneId={loaded.model.zoneId} actingSubject={actingSubject} copy={copy}
    zoneHead={revision} attachedRealm={realm} attachedName={realm ? name ?? copy.realmAttachedNameless : null} signInHref={signInHref} api={api} />;
}

function configurationRealm(configuration: unknown): string | null {
  if (!configuration || typeof configuration !== 'object' || !('defaultRealm' in configuration)) return null;
  const realm = configuration.defaultRealm;
  return typeof realm === 'string' && realmIri.test(realm) ? realm : null;
}

function realmName(data: unknown): string | null {
  if (!data || typeof data !== 'object' || !('name' in data)) return null;
  const name = data.name;
  if (!name || typeof name !== 'object' || !('value' in name) || typeof name.value !== 'string') return null;
  const value = name.value.trim();
  return value || null;
}
