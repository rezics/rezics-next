import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { manager } from '../../../../../../features/manage/server.ts';
import { isUuid } from '../../../../../../features/manage/types.ts';
import { ZoneLifecycleEditor } from '../../../../../../features/zone-editor/lifecycle-editor.tsx';
import { messages } from '../../../../../../features/zone-editor/messages.ts';
import { loadZoneLifecycle } from '../../../../../../features/zone-editor/read.ts';
import { zoneLifecyclePath } from '../../../../../../features/zone-editor/routes.ts';
import { ZoneAuthoringFailure } from '../../../../../../features/zone-editor/states.tsx';
import { requestLocale } from '../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: messages[await requestLocale()].lifecycleTitle };
}

export default async function ZoneLifecyclePage({ params, searchParams }: {
  params: Promise<{ space: string }>;
  searchParams: Promise<{ address?: string }>;
}) {
  const { space } = await params;
  const { address } = await searchParams;
  const locale = await requestLocale();
  const copy = messages[locale];
  const returnAddress = typeof address === 'string' ? address : isUuid(space) ? undefined : space;
  const { actingSubject, main, signInHref } = await manager(locale, zoneLifecyclePath(space, returnAddress));
  const loaded = await loadZoneLifecycle(main, space, locale, actingSubject);
  if (loaded.kind === 'missing') notFound();
  if (loaded.kind === 'failure') return <ZoneAuthoringFailure failure={loaded.failure} copy={copy} />;
  return <ZoneLifecycleEditor zoneId={loaded.zoneId} actingSubject={actingSubject} locale={locale}
    copy={copy} initial={{ revision: loaded.revision, status: loaded.status }} signInHref={signInHref}
    returnAddress={returnAddress} />;
}
