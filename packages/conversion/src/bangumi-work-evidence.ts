import {
  bangumiTVAnimeWorkEvidenceFields,
  isBangumiTVAnimeWorkEvidenceField,
  type BangumiTVAnimeWorkEvidenceField,
} from './bangumi-subject-profile.ts';

export type BangumiWorkEvidence = Readonly<{
  property: 'wdt:P973' | 'schema:copyrightNotice';
  value: string;
}>;

export type BangumiWorkEvidenceFieldState = {
  readonly key: BangumiTVAnimeWorkEvidenceField;
  readonly pointer: string;
  readonly property: BangumiWorkEvidence['property'];
  readonly inlineValue?: string;
  readonly inlineInvalid: boolean;
  hasInline: boolean;
  hasList: boolean;
  hasPlainContinuation: boolean;
  ambiguous: boolean;
  invalidListItem: boolean;
  invalidPlainContinuation: boolean;
  overflow: boolean;
  readonly listValues: string[];
  plainValue?: string;
}

export type BangumiWorkEvidenceDiagnostic = Readonly<{ pointer: string; code: string }>;
export type BangumiWorkEvidenceOmit = (pointer: string, code: string) => void;

const valueLimit = 1_500;
const linkLimit = 16;
const noticeLimit = 16;

function propertyFor(key: BangumiTVAnimeWorkEvidenceField): BangumiWorkEvidence['property'] {
  return key === bangumiTVAnimeWorkEvidenceFields.descriptiveLink ? 'wdt:P973' : 'schema:copyrightNotice';
}

function plainNotice(value: string): boolean {
  if (!value.trim() || value.length > valueLimit) return false;
  return !(
    value.includes('{{') ||
    value.includes('}}') ||
    value.includes('[[') ||
    value.includes(']]') ||
    value.includes("''") ||
    /^\*{1,2}[\t ]/u.test(value) ||
    /^\[[^\]]+\]$/u.test(value) ||
    /\[(?:https?:\/\/)[^\]]+\]/iu.test(value) ||
    /<\/?[A-Za-z][^>]*>/u.test(value)
  );
}

function descriptiveUrl(value: string): boolean {
  if (
    value.length > valueLimit ||
    !/^https?:\/\//u.test(value) ||
    /\s/u.test(value) ||
    /[\\<>|{}]/u.test(value) ||
    value.includes('[[') ||
    value.includes(']]') ||
    /%(?![0-9a-f]{2})/iu.test(value)
  )
    return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      Boolean(parsed.hostname) &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

function limitFor(property: BangumiWorkEvidence['property']): number {
  return property === 'wdt:P973' ? linkLimit : noticeLimit;
}

function invalidCode(property: BangumiWorkEvidence['property']): string {
  return property === 'wdt:P973' ? 'invalid_descriptive_link' : 'invalid_copyright_notice';
}

function overflowCode(property: BangumiWorkEvidence['property']): string {
  return property === 'wdt:P973' ? 'descriptive_link_limit' : 'copyright_notice_limit';
}

/**
 * Collects only the two pinned TVAnime work-evidence fields while the bounded
 * infobox scanner visits each field once. It never follows links or parses wiki
 * markup into a value.
 */
export function createBangumiWorkEvidenceCollector(omit: BangumiWorkEvidenceOmit) {
  const values: BangumiWorkEvidence[] = [];

  function begin(key: string, pointer: string, inlineValue: string, hasInline: boolean) {
    if (!isBangumiTVAnimeWorkEvidenceField(key)) return;
    const fieldKey = key as BangumiTVAnimeWorkEvidenceField;
    const property = propertyFor(fieldKey);
    const inlineInvalid = hasInline && inlineValue.length > valueLimit;
    return {
      key: fieldKey,
      pointer,
      property,
      ...(hasInline && !inlineInvalid ? { inlineValue } : {}),
      inlineInvalid,
      hasInline,
      hasList: false,
      hasPlainContinuation: false,
      ambiguous: false,
      invalidListItem: false,
      invalidPlainContinuation: false,
      overflow: false,
      listValues: [],
    } satisfies BangumiWorkEvidenceFieldState;
  }

  function continuation(field: BangumiWorkEvidenceFieldState | undefined, kind: 'list' | 'plain', value: string) {
    if (!field) return;
    if (kind === 'list') {
      field.hasList = true;
      if (!value.trim()) {
        field.invalidListItem = true;
        return;
      }
      if (value.length > valueLimit) {
        field.invalidListItem = true;
        return;
      }
      if (
        values.some((item) => item.property === field.property && item.value === value) ||
        field.listValues.includes(value)
      )
        return;
      if (field.listValues.length >= limitFor(field.property)) {
        field.overflow = true;
        return;
      }
      field.listValues.push(value);
      return;
    }

    if (field.hasPlainContinuation) {
      field.ambiguous = true;
      return;
    }
    field.hasPlainContinuation = true;
    if (!value.trim() || value.length > valueLimit) {
      field.invalidPlainContinuation = true;
      return;
    }
    field.plainValue = value;
  }

  function finish(field: BangumiWorkEvidenceFieldState | undefined) {
    if (!field) return;
    const formCount = Number(field.hasInline) + Number(field.hasList) + Number(field.hasPlainContinuation);
    if (field.ambiguous || formCount > 1) {
      omit(field.pointer, 'unsupported_infobox_work_evidence_form');
      return;
    }

    const candidates = field.hasInline
      ? field.inlineValue === undefined
        ? []
        : [field.inlineValue]
      : field.hasList
        ? field.listValues
        : field.plainValue === undefined
          ? []
          : [field.plainValue];
    if (field.inlineInvalid || field.invalidListItem || field.invalidPlainContinuation)
      omit(field.pointer, invalidCode(field.property));

    for (const value of candidates) {
      const valid = field.property === 'wdt:P973' ? descriptiveUrl(value) : plainNotice(value);
      if (!valid) {
        omit(field.pointer, invalidCode(field.property));
        continue;
      }
      if (values.some((item) => item.property === field.property && item.value === value)) continue;
      let count = 0;
      for (const item of values) if (item.property === field.property) count++;
      if (count >= limitFor(field.property)) {
        field.overflow = true;
        continue;
      }
      values.push({ property: field.property, value });
    }
    if (field.overflow) omit(field.pointer, overflowCode(field.property));
  }

  return {
    begin,
    continuation,
    finish,
    values(): readonly BangumiWorkEvidence[] {
      return [...values].sort((left, right) => {
        const a = `${left.property}\u0000${left.value}`;
        const b = `${right.property}\u0000${right.value}`;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    },
  };
}
