import type { Subject } from '../../../subject/types';
import { originalLanguage } from '../../../subject/language';
import { pageText } from '../../pages/shared';

const MAX_TITLES = 32;
const MAX_ALIASES = 48;
const MAX_DESCRIPTIONS = 16;

export type LiteraryName = { language: string; text: string };

export type LiteraryWorkIdentity = {
  id: string;
  title: ReturnType<typeof pageText>;
  titles: LiteraryName[];
  aliases: LiteraryName[];
  descriptions: LiteraryName[];
};

function languageEntries(value: Record<string, unknown> | undefined, maximum: number): LiteraryName[] {
  if (!value) return [];
  return Object.entries(value)
    .flatMap(([language, entry]) => {
      const values = Array.isArray(entry) ? entry : [entry];
      return values.flatMap((text) =>
        typeof text === 'string' && text.trim() ? [{ language, text: text.trim() }] : [],
      );
    })
    .slice(0, maximum);
}

/** The work retains every admitted language label without borrowing an edition's identity. */
export function literaryWorkIdentity(subject: Subject, locale: string): LiteraryWorkIdentity {
  return {
    id: subject.id,
    title: pageText(subject.labels, locale, originalLanguage(subject)),
    titles: languageEntries(subject.labels, MAX_TITLES),
    aliases: languageEntries(subject.aliases, MAX_ALIASES),
    descriptions: languageEntries(subject.descriptions, MAX_DESCRIPTIONS),
  };
}

export type LiteraryReaderObservation = {
  source: object;
  subject: string;
  locale: string;
  context: string | null;
  authority: string | null;
};

/** A replacement source starts a fresh window; changes to the same source retire its displayed identity. */
export function literaryReaderRetired(
  captured: LiteraryReaderObservation,
  current: LiteraryReaderObservation,
): boolean {
  if (captured.source !== current.source || captured.subject !== current.subject) return false;
  return (
    captured.locale !== current.locale ||
    captured.context !== current.context ||
    (captured.authority !== null && captured.authority !== current.authority)
  );
}

export function literaryAuthorityKey(session: {
  state: string;
  subject?: string | null;
  csrfToken: string | null;
}): string | null {
  return session.state === 'unknown' ? null : `${session.state}:${session.subject ?? ''}:${session.csrfToken ?? ''}`;
}
