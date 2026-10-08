import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { manager } from '../../../../../../features/manage/server.ts';
import { settle } from '../../../../../../features/manage/read.ts';
import { messages } from '../../../../../../features/zone-editor/messages.ts';
import { RealmAttachmentEditor } from '../../../../../../features/zone-editor/realm-attachment.tsx';
import { loadZoneAuthoring } from '../../../../../../features/zone-editor/read.ts';
import { zoneRealmPath } from '../../../../../../features/zone-editor/routes.ts';
import { ZoneAuthoringFailure } from '../../../../../../features/zone-editor/states.tsx';
import { requestLocale } from '../../../../../../i18n/server.ts';

const realmIri = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export async function generateMetadata(): Promise<Metadata> {
  return { title: messages[await requestLocale()].realmTitle };
}

export default async function ZoneRealmPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  const locale = await requestLocale();
  const copy = messages[locale];
  const { actingSubject, main, anonymous, signInHref } = await manager(locale, zoneRealmPath(space));
  const loaded = await loadZoneAuthoring(main, space, locale, actingSubject);
  if (loaded.kind === 'missing') notFound();
  if (loaded.kind === 'failure') return <ZoneAuthoringFailure failure={loaded.failure} copy={copy} />;
  const read = await settle(() => main.v1.zones({ id: loaded.model.zoneId }).configuration.get({ query: { actingSubject } }),
    { management: true });
  if (!read.ok) return <ZoneAuthoringFailure failure={read.failure} copy={copy} />;
  const revision = read.data.revision;
  const realm = configurationRealm(read.data.configuration);
  if (!revision) return <ZoneAuthoringFailure failure="unavailable" copy={copy} />;
  const named = realm ? await settle(() => anonymous.v1.realms({ realm: realm.slice(-36) }).get({ query: {} })) : null;
  const name = named?.ok ? realmName(named.data) : null;
  return <RealmAttachmentEditor zoneId={loaded.model.zoneId} actingSubject={actingSubject} copy={copy}
    zoneHead={revision} attachedName={realm ? name ?? copy.realmAttachedNameless : null} signInHref={signInHref} />;
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
