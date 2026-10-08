import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { manager } from '../../../../../features/manage/server.ts';
import { ZoneHomeEditor } from '../../../../../features/zone-editor/editor.tsx';
import { messages } from '../../../../../features/zone-editor/messages.ts';
import { loadZoneAuthoring } from '../../../../../features/zone-editor/read.ts';
import { zoneEditorPath } from '../../../../../features/zone-editor/routes.ts';
import { ZoneAuthoringFailure } from '../../../../../features/zone-editor/states.tsx';
import { requestLocale } from '../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: messages[await requestLocale()].homeTitle };
}

export default async function ZoneHomePage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  const locale = await requestLocale();
  const { actingSubject, main, signInHref } = await manager(locale, zoneEditorPath(space));
  const loaded = await loadZoneAuthoring(main, space, locale, actingSubject);
  if (loaded.kind === 'missing') notFound();
  if (loaded.kind === 'failure') return <ZoneAuthoringFailure failure={loaded.failure} copy={messages[locale]} />;
  const { model, previewPath, sitePath } = loaded;
  return <ZoneHomeEditor zoneId={model.zoneId} zoneIri={model.zoneIri} actingSubject={actingSubject} locale={locale}
    copy={messages[locale]} initial={model.state} editable={model.editable} document={model.document}
    previewHref={previewPath} siteHref={sitePath} signInHref={signInHref} />;
}
