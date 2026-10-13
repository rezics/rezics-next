import { ResolvedMediaImages } from '@rezics/ui/media-image';
import type { ZoneContext, ZonePackage } from '@rezics/zone-sdk';
import type { ReactNode } from 'react';
import type { AdaptContext } from '../realm/adapt.ts';
import type { ZonePresentationRead } from '../realm/types.ts';
import type { ZoneMessages } from '../zones/messages.ts';
import { loadZoneHomeModules, ZonePublishedHome } from '../zones/zone-home-recorded-page.tsx';
import type { ZoneHomePage } from './home-document.tsx';
import type { ZoneAuthoringPreview } from './read.ts';
import type { ZoneEditorMessages } from './messages.ts';
import { ZonePreviewHome } from './preview.tsx';

interface HomeContext {
  context: AdaptContext;
  zone: ZoneContext;
  pkg: ZonePackage | null;
  messages: ZoneMessages;
}

/** The public publication uses Main's public source reads. */
export async function ZoneHomeContent({ page, presentation, moduleData, slideMedia, context, zone, pkg, messages, empty }: HomeContext & {
  page: ZoneHomePage | null;
  presentation: ZonePresentationRead['presentation'];
  moduleData: ZonePresentationRead['moduleData'];
  slideMedia: ZonePresentationRead['slideMedia'];
  empty?: ReactNode;
}) {
  const loaded = await loadZoneHomeModules(page, presentation, { moduleData, slideMedia }, context, messages.moduleHeroCarousel);
  return <ZonePublishedHome page={page} modules={loaded.modules} images={loaded.images}
    representedShowcases={loaded.representedShowcases} zone={zone} pkg={pkg} locale={context.locale}
    messages={messages} avatarQuery={context.avatarQuery} empty={empty} />;
}

/** The saved producer remains distinct from the public page throughout adaptation. */
export async function ZoneSavedHomeContent({ preview, context, zone, pkg, messages, copy }: HomeContext & {
  preview: ZoneAuthoringPreview;
  copy: ZoneEditorMessages;
}) {
  const loaded = await loadZoneHomeModules(preview.page, preview.presentation, preview, context, messages.moduleHeroCarousel);
  return <ResolvedMediaImages images={loaded.images}>
    <ZonePreviewHome page={preview.page} modules={loaded.modules} zone={zone} pkg={pkg} locale={context.locale}
      messages={messages} copy={copy} avatarQuery={context.avatarQuery} representedShowcases={loaded.representedShowcases} />
  </ResolvedMediaImages>;
}
