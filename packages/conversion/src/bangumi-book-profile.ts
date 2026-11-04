export const bangumiBookGrains = ['schema:Book', 'schema:BookSeries', 'bf:Instance'] as const;
export type BangumiBookGrain = (typeof bangumiBookGrains)[number];

/** Pinned book platforms except comic/manga (1001) and unspecified 0. */
const NOVEL_PLATFORMS = new Set(['1002', '1003', '1004', '1005', '1006']);
const COMIC_PLATFORM = '1001';
const BOOK_TEMPLATES = new Set(['Novel', 'Book', 'BookSeries', 'PhotoBook', 'Manga']);
const ADMITTED_INFOBOX_KEYS = new Set([
  '中文名',
  '别名',
  '作者',
  '插图',
  '出版社',
  '其他出版社',
  '价格',
  '连载杂志',
  '发售日',
  '开始',
  '结束',
  '册数',
  '页数',
  '话数',
  'ISBN',
  'ISBN-10',
  '链接',
  '其他',
  '文库',
]);

export type BangumiBookInfoboxField = Readonly<{
  key: string;
  value: string;
}>;

export type BangumiBookInfobox = Readonly<{
  template?: string;
  fields: readonly BangumiBookInfoboxField[];
  omitted: readonly { key: string; reason: string }[];
}>;

export type BangumiBookProfile = Readonly<{
  outcome: 'selected';
  type: BangumiBookGrain;
  template?: string;
}>;

/** First-line wiki template only; the raw body is not a catalogue value. */
export function bangumiInfoboxTemplate(infobox: string | undefined): string | undefined {
  if (infobox === undefined) return;
  const head = infobox.slice(0, 256).split(/\r?\n/u, 1)[0] ?? '';
  const match = /Infobox(?:\s+|\/)([A-Za-z][A-Za-z0-9]*)\b/u.exec(head);
  return match?.[1];
}

/**
 * Bounded top-level wiki keys. Nested version/alias blocks stay unmaterialized;
 * they have no subject identity and cannot become editions.
 */
export function parseBangumiBookInfobox(infobox: string | undefined): BangumiBookInfobox {
  if (infobox === undefined) return { fields: [], omitted: [] };
  const template = bangumiInfoboxTemplate(infobox);
  const fields: BangumiBookInfoboxField[] = [];
  const omitted: { key: string; reason: string }[] = [];
  let depth = 0;
  let pending = '';
  for (const raw of infobox.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line) continue;
    for (const unit of line) {
      if (unit === '{') depth += 1;
      else if (unit === '}' && depth > 0) depth -= 1;
    }
    if (depth > 2) continue;
    if (!line.startsWith('|')) continue;
    const cut = line.indexOf('=');
    if (cut <= 1) continue;
    const key = line.slice(1, cut).trim();
    const value = line.slice(cut + 1).trim();
    if (!key || key.includes(':')) {
      omitted.push({ key: key || line.slice(1, 32), reason: 'nested_or_unidentified_infobox_key' });
      continue;
    }
    if (!ADMITTED_INFOBOX_KEYS.has(key)) {
      omitted.push({ key, reason: 'unsupported_infobox_key' });
      continue;
    }
    if (value === '' || value === '{' || value === '}') continue;
    pending = value.endsWith('{') ? value.slice(0, -1).trim() : value;
    if (pending) fields.push({ key, value: pending });
  }
  return template ? { template, fields, omitted } : { fields, omitted };
}

export function bangumiInfoboxField(parsed: BangumiBookInfobox, key: string): string | undefined {
  return parsed.fields.find((field) => field.key === key)?.value;
}

/**
 * Dispatch one type-1 subject from platform, series flag and template.
 * Comic/manga stays generic Book so this journey never substitutes manga for a novel.
 * One source subject stays one identity: ISBN never invents an Instance.
 */
export function selectBangumiBookProfile(input: {
  readonly type: 1;
  readonly platform?: string;
  readonly series?: boolean;
  readonly infobox?: string;
}): BangumiBookProfile {
  const template = bangumiInfoboxTemplate(input.infobox);
  const platform = input.platform?.trim();
  if (platform === COMIC_PLATFORM || template === 'Manga')
    return template
      ? { outcome: 'selected', type: 'schema:Book', template }
      : { outcome: 'selected', type: 'schema:Book' };
  if (
    input.series === true &&
    (platform === undefined ||
      platform === '' ||
      NOVEL_PLATFORMS.has(platform) ||
      template === 'Novel' ||
      template === 'BookSeries' ||
      template === 'Book' ||
      template === 'PhotoBook')
  )
    return {
      outcome: 'selected',
      type: 'schema:BookSeries',
      ...(template && BOOK_TEMPLATES.has(template) ? { template } : {}),
    };
  return {
    outcome: 'selected',
    type: 'schema:Book',
    ...(template && BOOK_TEMPLATES.has(template) ? { template } : {}),
  };
}

export function bangumiEditionFactsWithheldOnWork(parsed: BangumiBookInfobox): { pointer: string; code: string }[] {
  const codes: Record<string, string> = {
    ISBN: 'edition_assertion_withheld_on_work',
    'ISBN-10': 'edition_assertion_withheld_on_work',
    出版社: 'edition_assertion_withheld_on_work',
    其他出版社: 'edition_assertion_withheld_on_work',
    页数: 'edition_assertion_withheld_on_work',
    册数: 'count_does_not_create_volumes',
    话数: 'count_does_not_create_volumes',
  };
  return parsed.fields
    .filter((field) => codes[field.key])
    .map((field) => ({ pointer: `/infobox/${field.key}`, code: codes[field.key]! }));
}
