import { defineZonePackage } from '@rezics/zone-sdk';
import { releaseFilter } from './release-filter.ts';
import { VisualNovelBrowseHeader, VisualNovelCard, VisualNovelDetail, VisualNovelFooter } from './slots.tsx';
import css from './visual-novels.css?raw';

/**
 * The official Visual Novels Zone (`/r/visual-novels`): readers choose a language, platform, completeness
 * and official or fan translation, and get only visual novels that have one release meeting all of them,
 * each result naming that release. A novel's page leads with where it can be played. It states what it
 * does not cover and credits VNDB where its data appears.
 */
export default defineZonePackage({
  slug: 'visual-novels',
  css,
  releaseFilter,
  slots: { browseHeader: VisualNovelBrowseHeader, workCard: VisualNovelCard, workDetail: VisualNovelDetail,
    footer: VisualNovelFooter },
});
