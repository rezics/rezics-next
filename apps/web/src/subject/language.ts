import type { Subject } from './types.ts';

/** The property whose values are language codes. */
export const LANGUAGE_PROPERTY = 'schema:inLanguage';
const NAME_PROPERTY = 'schema:name';
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;

// The kernel client infers statements as one large union; only these fields are read, and each is checked below.
type Statement = { rank: string; value: { type: string; content?: unknown } };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statementsOf(subject: Subject, property: string): Statement[] {
  const all = subject.statements as unknown as Record<string, Statement[]>;
  const statements = Object.hasOwn(all, property) ? all[property] : undefined;
  if (!statements) return [];
  const preferred = statements.filter((statement) => statement.rank === 'preferred');
  return preferred.length ? preferred : statements.filter((statement) => statement.rank === 'normal');
}

/** The language a subject was first written in: its original title's, otherwise its `schema:inLanguage`. */
export function originalLanguage(subject: Subject): string | undefined {
  for (const statement of statementsOf(subject, NAME_PROPERTY)) {
    const content = statement.value.type === 'value' ? statement.value.content : undefined;
    if (record(content) && typeof content.language === 'string' && LANGUAGE_CODE.test(content.language))
      return content.language;
  }
  for (const statement of statementsOf(subject, LANGUAGE_PROPERTY)) {
    const content = statement.value.type === 'value' ? statement.value.content : undefined;
    if (typeof content === 'string' && LANGUAGE_CODE.test(content)) return content;
  }
}

/** The title the subject was first written under, with its language, when it has one. */
export function originalTitle(subject: Subject): { text: string; lang: string } | undefined {
  const lang = originalLanguage(subject);
  if (lang === undefined) return undefined;
  const label = Object.hasOwn(subject.labels, lang) ? subject.labels[lang] : undefined;
  if (label) return { text: label, lang };
  for (const statement of statementsOf(subject, NAME_PROPERTY)) {
    const content = statement.value.type === 'value' ? statement.value.content : undefined;
    if (record(content) && content.language === lang && typeof content.text === 'string' && content.text)
      return { text: content.text, lang };
  }
}

/** The name of a language the reader did not ask for, in the reader's language; undefined for their own. */
export function foreignLanguageName(lang: string | null | undefined, locale: string): string | undefined {
  if (!lang || lang === locale) return undefined;
  const primary = (tag: string) => tag.split('-')[0];
  // The unqualified language (`zh` for a `zh-Hans` reader) is theirs too.
  if (lang === primary(locale)) return undefined;
  return languageName(lang, locale);
}

/** A language's name in the reader's language; a code the platform has no name for has none. */
export function languageName(code: string, locale: string): string | undefined {
  if (!LANGUAGE_CODE.test(code)) return undefined;
  try {
    return new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' }).of(code) ?? undefined;
  } catch {
    return undefined;
  }
}
