import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { manager } from '../../../../../../features/manage/server.ts';
import { settle } from '../../../../../../features/manage/read.ts';
import { ZoneThemeEditor } from '../../../../../../features/zone-editor/theme-editor.tsx';
import { themeEditorStart } from '../../../../../../features/zone-editor/zone-navigation-theme-recorded-page.ts';
import { messages } from '../../../../../../features/zone-editor/messages.ts';
import { loadZoneAuthoring } from '../../../../../../features/zone-editor/read.ts';
import { zoneThemePath } from '../../../../../../features/zone-editor/routes.ts';
import { ZoneAuthoringFailure } from '../../../../../../features/zone-editor/states.tsx';
import { defaultPresentation } from '../../../../../../features/zones/presentation.ts';
import { getMessages, requestLocale } from '../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: messages[await requestLocale()].themeTitle };
}

export default async function ZoneThemePage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  const locale = await requestLocale();
  const copy = messages[locale];
  const { actingSubject, main, signInHref } = await manager(locale, zoneThemePath(space));
  const loaded = await loadZoneAuthoring(main, space, locale, actingSubject);
  if (loaded.kind === 'missing') notFound();
  if (loaded.kind === 'failure') return <ZoneAuthoringFailure failure={loaded.failure} copy={copy} />;

  const [zoneMessages, read] = await Promise.all([
    getMessages('zones', locale),
    settle(() => main.v1.zones({ id: loaded.model.zoneId }).configuration.get({ query: { actingSubject } }),
      { management: true }),
  ]);
  if (!read.ok) return <ZoneAuthoringFailure failure={read.failure} copy={copy} />;
  if (typeof read.data.revision !== 'string') return <ZoneAuthoringFailure failure="unavailable" copy={copy} />;
  const shellPresentation = defaultPresentation(zoneMessages);

  return <ZoneThemeEditor zoneId={loaded.model.zoneId} actingSubject={actingSubject} copy={copy}
    initial={themeEditorStart(read.data.configuration, read.data.revision, shellPresentation)}
    shellPresentation={shellPresentation} signInHref={signInHref}
    previewHref={loaded.previewPath} siteHref={loaded.sitePath} />;
}
