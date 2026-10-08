import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { manager } from '../../../../../../features/manage/server.ts';
import { settle } from '../../../../../../features/manage/read.ts';
import { withPageNames } from '../../../../../../features/zone-editor/api.ts';
import { messages } from '../../../../../../features/zone-editor/messages.ts';
import { ZoneNavigationEditor } from '../../../../../../features/zone-editor/navigation-editor.tsx';
import { linksFromZone, type NavigationState } from '../../../../../../features/zone-editor/navigation.ts';
import { loadZoneAuthoring } from '../../../../../../features/zone-editor/read.ts';
import { zoneNavigationPath } from '../../../../../../features/zone-editor/routes.ts';
import { ZoneAuthoringFailure } from '../../../../../../features/zone-editor/states.tsx';
import { requestLocale } from '../../../../../../i18n/server.ts';
import type { EditorState } from '../../../../../../features/zone-editor/model.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: messages[await requestLocale()].navTitle };
}

export default async function ZoneNavigationPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  const locale = await requestLocale();
  const copy = messages[locale];
  const { actingSubject, main, signInHref } = await manager(locale, zoneNavigationPath(space));
  const loaded = await loadZoneAuthoring(main, space, locale, actingSubject);
  if (loaded.kind === 'missing') notFound();
  if (loaded.kind === 'failure') return <ZoneAuthoringFailure failure={loaded.failure} copy={copy} />;
  const read = await settle(() => main.v1.zones({ id: loaded.model.zoneId }).get({ query: { actingSubject, limit: 50 } }), { management: true });
  if (!read.ok) return <ZoneAuthoringFailure failure={read.failure} copy={copy} />;
  const parsed = linksFromZone(read.data);
  if (!parsed) return <ZoneAuthoringFailure failure="unavailable" copy={copy} />;
  const links = await withPageNames(main, parsed.links, actingSubject);
  const initial: NavigationState = { links, saved: links.map(link => ({ ...link })), head: parsed.head, notice: { kind: 'idle' } };
  const zoneHead = record(read.data)?.ownerRevision;
  const home: EditorState = {
    ...loaded.model.state,
    navigationRevision: parsed.head,
    ...(typeof zoneHead === 'string' && /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(zoneHead) ? { zoneHead } : {}),
  };
  const { model, previewPath, sitePath } = loaded;
  return <ZoneNavigationEditor zoneId={model.zoneId} zoneIri={model.zoneIri} actingSubject={actingSubject} locale={locale}
    copy={copy} initial={initial} home={home} previewHref={previewPath} siteHref={sitePath}
    signInHref={signInHref} />;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}
