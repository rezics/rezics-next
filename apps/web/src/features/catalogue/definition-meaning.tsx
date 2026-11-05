import { m } from '../../paraglide/messages.js';
import { languageName } from '../../subject/language';
import { definitionText } from './definition-guide';

type Meaning =
  | { values?: Record<string, string> | undefined; text?: never; language?: never }
  | { values?: never; text: string | undefined; language?: string | undefined };

/** Released guidance with its actual language; shadcn has no definition-language presentation. */
export function DefinitionMeaning({ locale, ...meaning }: Meaning & { locale: string }) {
  const chosen =
    'text' in meaning ? { text: meaning.text, lang: meaning.language } : definitionText(meaning.values, locale);
  const o = { locale: locale as never };
  if (!chosen.text)
    return (
      <span lang={locale} className="text-muted-foreground">
        {m.guide_missing({}, o)}
      </span>
    );
  return (
    <span>
      <span lang={chosen.lang ?? undefined}>{chosen.text}</span>
      {chosen.lang && chosen.lang !== locale && (
        <span lang={locale} className="ms-2 text-sm text-muted-foreground">
          {m.guide_fallback({ language: languageName(chosen.lang, locale) ?? chosen.lang }, o)}
        </span>
      )}
    </span>
  );
}
