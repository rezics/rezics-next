import { isBangumiGameTemplateHead } from './bangumi-subject-profile.ts';
import {
  extractBangumiNamesForTemplate,
  type BangumiNameExtraction,
  type BangumiNameRecord,
} from './bangumi-subject-names.ts';

/** Game-template names are independent from television and character name owners. */
export function extractBangumiGameNames(record: BangumiNameRecord): BangumiNameExtraction {
  return extractBangumiNamesForTemplate(record, {
    type: 4,
    isTemplateHead: isBangumiGameTemplateHead,
    listFields: new Set(['别名']),
    retainedOtherFields: new Set(['游玩人数', '平台', '游戏引擎', '发行日期', 'website', '链接']),
  });
}
