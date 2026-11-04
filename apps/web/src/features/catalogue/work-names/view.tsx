import { languageName } from '../../../subject/language';
import { m } from '../../../paraglide/messages.js';
import { PeopleNamesView } from '../people-names/view';
import type { WorkNames } from './model';

/** Share the finite name window and safe copy controls while retaining work-only language evidence. */
export function WorkNamesView({
  names,
  locale,
  sourcesHref,
  termsHref = '',
  ...props
}: {
  names: WorkNames;
  locale: string;
  sourcesHref: string;
} & Omit<Parameters<typeof PeopleNamesView>[0], 'names' | 'locale' | 'sourcesHref' | 'advice' | 'termsHref'> & {
    advice?: Parameters<typeof PeopleNamesView>[0]['advice'];
    termsHref?: string;
  }) {
  const o = { locale: locale as never };
  return (
    <PeopleNamesView
      {...props}
      kind="work"
      locale={locale}
      sourcesHref={sourcesHref}
      termsHref={termsHref}
      advice={props.advice ?? 'unavailable'}
      names={names.state === 'ready' ? names : { state: 'oversized' }}
      metadata={
        names.state === 'ready' && (
          <p>
            {m.work_names_original({}, o)}{' '}
            {names.originalLanguage
              ? (languageName(names.originalLanguage, locale) ?? names.originalLanguage)
              : m.work_names_unknown({}, o)}
            {names.original && (
              <>
                :{' '}
                <span lang={names.original.lang} dir="auto">
                  {names.original.text}
                </span>
              </>
            )}
          </p>
        )
      }
    />
  );
}
