import type { Metadata } from 'next';
import { manager } from '../../../../../../features/manage/server.ts';
import { zoneLifecycleBody } from '../../../../../../features/zone-editor/zone-lifecycle-recorded-page.ts';
import { messages } from '../../../../../../features/zone-editor/messages.ts';
import { loadZoneLifecycle, loadZoneRecoveryReturnAddress } from '../../../../../../features/zone-editor/read.ts';
import { zoneLifecyclePath } from '../../../../../../features/zone-editor/routes.ts';
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
  const { actingSubject, main, signInHref } = await manager(locale, zoneLifecyclePath(space, address));
  const loaded = await loadZoneLifecycle(main, space, locale, actingSubject);
  const returnAddress = loaded.kind === 'ready'
    ? await loadZoneRecoveryReturnAddress(main, address ?? loaded.returnAddress, loaded, actingSubject) : undefined;
  return zoneLifecycleBody(loaded, { locale, actingSubject, signInHref, returnAddress });
}
