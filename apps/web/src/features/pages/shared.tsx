import { pickText } from '@rezics/composition';
import type { ComponentType, ReactNode } from 'react';
import type { Summary } from '../../subject/types';
import { SPOILER_PROPERTY } from './values';

export type LinkProps = {
  href: string;
  lang?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
};
export type PageLink = ComponentType<LinkProps>;

export type Snak = {
  property: { id: string; data_type: string };
  value: { type: string; content?: unknown };
};
// The kernel client infers statements as one large union; only these fields are read.
export type Stmt = Snak & {
  id: string;
  rank: string;
  qualifiers: Snak[];
  references: { parts: Snak[] }[];
};
export type Sources = {
  credit: NonNullable<Summary['cover']>['credit'] | null;
  records: unknown[];
  urls: string[];
  identifiers: { label: ReturnType<typeof pageText>; value: string }[];
};

export const linkClass = 'underline-offset-4';
export const linkColor = 'text-primary';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Localized props and read text share the composition fallback chain; `original` is the subject's first language. */
export function pageText(value: unknown, locale: string, original?: string) {
  const safe = typeof value === 'string' || isRecord(value) ? value : '';
  const picked = pickText(safe as string | Record<string, string>, locale, original);
  return {
    text: typeof picked.text === 'string' ? picked.text : '',
    lang: picked.lang && picked.lang !== locale ? picked.lang : undefined,
  };
}

/** A property label used as a field or section name, capitalized in the label's language. */
export function fieldLabel<T extends { text: string; lang?: string | undefined }>(label: T, locale: string): T {
  if (!label.text) return label;
  const [first, ...rest] = Array.from(label.text);
  return { ...label, text: `${first!.toLocaleUpperCase(label.lang ?? locale)}${rest.join('')}` };
}

export function PlainLink({ href, lang, className, children }: LinkProps) {
  return (
    <a href={href} lang={lang} className={className}>
      {children}
    </a>
  );
}

/** Only absolute web URLs become external links, including in references. */
export function webUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function ExternalValue({ value }: { value: string }) {
  return webUrl(value) ? (
    <a className={`${linkClass} ${linkColor} break-all`} href={value}>
      {value}
    </a>
  ) : (
    <span>{value}</span>
  );
}

/** The spoiler level a statement is qualified with: 0 when it has none, 2 for a level that cannot be read. */
export function spoilerLevel(statement: Stmt): number {
  let level = 0;
  for (const qualifier of statement.qualifiers) {
    if (qualifier.property.id !== SPOILER_PROPERTY) continue;
    const content = qualifier.value.type === 'value' ? qualifier.value.content : undefined;
    const amount = isRecord(content) ? Number(content.amount) : Number.NaN;
    level = Math.max(level, Number.isInteger(amount) ? Math.min(2, Math.max(0, amount)) : 2);
  }
  return level;
}

/** The statements that count: the preferred ones when there are any, else the normal ones. */
export function bestRank(statements: Stmt[]): Stmt[] {
  const preferred = statements.filter((statement) => statement.rank === 'preferred');
  return preferred.length ? preferred : statements.filter((statement) => statement.rank === 'normal');
}
