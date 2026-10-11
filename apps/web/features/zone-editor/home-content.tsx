import { ResolvedMediaImages } from '@rezics/ui/media-image';
import type { ZoneContext, ZonePackage } from '@rezics/zone-sdk';
import type { UiLocale } from '../../i18n/define.ts';
import type { AdaptContext } from '../realm/adapt.ts';
import { loadHomeModules } from '../realm/modules.ts';
import type { ZonePresentationRead } from '../realm/types.ts';
import type { ZoneMessages } from '../zones/messages.ts';
import { moduleTitle, type ZonePresentation } from '../zones/presentation.ts';
import { ZoneDocumentHome } from '../zones/site-pages.tsx';
import type { ZoneHomePage } from './home-document.tsx';

/** Both publication and the authorized preview use the host's existing Showcase and module renderer. */
export async function ZoneHomeContent({ page, presentation, slideMedia, context, zone, pkg, messages, preview = false }: {
  page: ZoneHomePage;
  presentation: ZonePresentationRead['presentation'];
  slideMedia: ZonePresentationRead['slideMedia'];
  context: AdaptContext;
  zone: ZoneContext;
  pkg: ZonePackage | null;
  messages: ZoneMessages;
  preview?: boolean;
}) {
  const localized = localizedHomePresentation(presentation, context.locale);
  const { modules, images } = await loadHomeModules(localized, context, slideMedia);
  return <ResolvedMediaImages images={images}>
    <ZoneDocumentHome page={page} modules={modules} zone={zone} pkg={pkg} locale={context.locale}
      messages={messages} avatarQuery={context.avatarQuery} preview={preview} />
  </ResolvedMediaImages>;
}

function localizedHomePresentation(presentation: ZonePresentationRead['presentation'], locale: UiLocale): ZonePresentation {
  return { ...presentation, modules: presentation.modules.map(({ titles, tabs, ...module }) => ({
    ...module, title: moduleTitle({ title: module.title, titles }, locale),
    ...(tabs ? { tabs: tabs.map(({ labels, ...tab }) => ({ ...tab, label: labels?.[locale] ?? tab.label })) } : {}),
  })) };
}
