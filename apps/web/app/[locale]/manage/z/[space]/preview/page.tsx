import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { manager } from '../../../../../../features/manage/server.ts';
import { messages } from '../../../../../../features/zone-editor/messages.ts';
import { ZoneDraftPreview } from '../../../../../../features/zone-editor/preview.tsx';
import { loadZoneAuthoring } from '../../../../../../features/zone-editor/read.ts';
import { zonePreviewPath } from '../../../../../../features/zone-editor/routes.ts';
import { ZoneAuthoringFailure } from '../../../../../../features/zone-editor/states.tsx';
import { requestLocale } from '../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: messages[await requestLocale()].previewTitle };
}

/** The saved draft. People who cannot edit are refused; this route never falls back to the public page. */
export default async function ZoneDraftPreviewPage({ params }: { params: Promise<{ space: string }> }) {
  const { space } = await params;
  const locale = await requestLocale();
  const { actingSubject, main } = await manager(locale, zonePreviewPath(space));
  const loaded = await loadZoneAuthoring(main, space, locale, actingSubject);
  if (loaded.kind === 'missing') notFound();
  if (loaded.kind === 'failure') return <ZoneAuthoringFailure failure={loaded.failure} copy={messages[locale]} />;
  const { model, editorPath, sitePath } = loaded;
  const published = model.state.publishedRevisionId;
  const status = !published ? 'private' : model.state.basis?.revisionId === published ? 'live' : 'behind';
  return <ZoneDraftPreview copy={messages[locale]} document={model.document} editorPath={editorPath} sitePath={sitePath} status={status} />;
}
