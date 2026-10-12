import { ResolvedMediaImages } from '@rezics/ui/media-image';
import type { ZoneContext, ZonePackage } from '@rezics/zone-sdk';
import type { AdaptContext } from '../realm/adapt.ts';
import { readShowcaseWorks } from '../api/showcase.ts';
import { enrichShowcaseModules, loadModules, moduleMoreHref, readHeroImages, showcaseContext,
  summaryWork } from '../realm/modules.ts';
import type { ZonePresentationRead } from '../realm/types.ts';
import type { ZoneMessages } from '../zones/messages.ts';
import { ZoneDocumentHome } from '../zones/site-pages.tsx';
import type { ZoneHomePage } from './home-document.tsx';
import { loadDocumentHomeModules, localizedHomePresentation } from './home-modules.ts';
import type { ZoneAuthoringPreview } from './read.ts';
import type { ZoneEditorMessages } from './messages.ts';
import { ZonePreviewHome } from './preview.tsx';
import { ZoneHome } from '../zones/zone-home.tsx';
import type { ReactNode } from 'react';

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
  const localized = localizedHomePresentation(presentation, context.locale);
  const { modules, images, representedShowcases } = await loadDocumentHomeModules(page, { moduleData, slideMedia }, localized, context, {
    publicModules: loadModules, summaries: readShowcaseWorks, work: summaryWork, context: showcaseContext,
    more: moduleMoreHref, enrich: enrichShowcaseModules, images: readHeroImages,
  }, messages.moduleHeroCarousel);
  return <ResolvedMediaImages images={images}>
    {page ? <ZoneDocumentHome page={page} modules={modules} zone={zone} pkg={pkg} locale={context.locale}
      messages={messages} avatarQuery={context.avatarQuery} representedShowcases={representedShowcases} />
      : <ZoneHome modules={modules} zone={zone} pkg={pkg} locale={context.locale}
        messages={messages} avatarQuery={context.avatarQuery} empty={empty} />}
  </ResolvedMediaImages>;
}

/** The saved producer remains distinct from the public page throughout adaptation. */
export async function ZoneSavedHomeContent({ preview, context, zone, pkg, messages, copy }: HomeContext & {
  preview: ZoneAuthoringPreview;
  copy: ZoneEditorMessages;
}) {
  const presentation = localizedHomePresentation(preview.presentation, context.locale);
  const { modules, images, representedShowcases } = await loadDocumentHomeModules(preview.page, preview, presentation, context, {
    publicModules: loadModules, summaries: readShowcaseWorks, work: summaryWork, context: showcaseContext,
    more: moduleMoreHref, enrich: enrichShowcaseModules, images: readHeroImages,
  }, messages.moduleHeroCarousel);
  return <ResolvedMediaImages images={images}>
    <ZonePreviewHome page={preview.page} modules={modules} zone={zone} pkg={pkg} locale={context.locale}
      messages={messages} copy={copy} avatarQuery={context.avatarQuery} representedShowcases={representedShowcases} />
  </ResolvedMediaImages>;
}
