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
  });
}
