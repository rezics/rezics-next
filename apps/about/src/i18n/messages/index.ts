import type { PageId } from '../../pages.ts';
import type { UiLocale } from '../locales.ts';
import { acgn } from './acgn.ts';
import { communities } from './communities.ts';
import { developers } from './developers.ts';
import { distribution } from './distribution.ts';
import { featureCopy } from './features.ts';
import { home } from './home.ts';
import { illustrations } from './illustrations.ts';
import { lightNovels } from './light-novels.ts';
import type { PageCopy } from './page.ts';
import { reading } from './reading.ts';
import { roadmap } from './roadmap.ts';
import { serialFiction } from './serial-fiction.ts';
import { site } from './site.ts';
import { trust } from './trust.ts';
import { wikis } from './wikis.ts';

/** Every catalog by name; `tests/catalogs.test.ts` checks each one against English. */
export const catalogs = {
  site,
  features: featureCopy,
  illustrations,
  home,
  reading,
  'light-novels': lightNovels,
  'serial-fiction': serialFiction,
  acgn,
  wikis,
  communities,
  distribution,
  developers,
  trust,
  roadmap,
} as const;

/** The product pages that share the `PageCopy` shape, by page id. */
export const productPages: Record<
  Exclude<PageId, 'home' | 'roadmap'>,
  Record<UiLocale, PageCopy>
> = {
  reading,
  'light-novels': lightNovels,
  'serial-fiction': serialFiction,
  acgn,
  wikis,
  communities,
  distribution,
  developers,
  trust,
};
