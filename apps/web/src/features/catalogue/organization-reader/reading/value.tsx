import { pageDocumentReferences, pickText } from '@rezics/composition';
import { CandidateValue } from '../../../pages/data';
import { LanguageTag } from '../../../pages/values';
import { type PageLink, type Snak } from '../../../pages/shared';
import { subjectHref } from '../../../../subject/subject-href';
import { m } from '../../../../paraglide/messages.js';
import type { OrganizationReading } from '../index';

export const organizationControl =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal py-2 text-left underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [overflow-wrap:anywhere]';

/** Values and every evidence part use their own admitted definition and disclosed target. */
export function OrganizationValue({
  part,
  read,
  documents,
  locale,
  link: Link,
}: {
  part: Snak & { id?: string };
  read: OrganizationReading;
  documents?: unknown;
  locale: string;
  link: PageLink;
}) {
  const o = { locale: locale as never };
  const definition = read.release.properties[part.property.id];
  if (!definition || definition.datatype !== part.property.data_type)
    return <span>{m.candidate_value_unavailable({}, o)}</span>;
  if (part.value.type === 'value' && part.property.data_type === 'wikibase-item') {
    const id = part.value.content;
    const related = read.public.related;
    if (typeof id !== 'string' || !Object.hasOwn(related, id) || !related[id])
      return <span>{m.people_biography_unreadable({}, o)}</span>;
    const target = pickText(related[id].labels, locale);
    return (
      <Link
        href={subjectHref({ id, label: target.text }, locale).href}
        lang={target.lang ?? undefined}
        className={organizationControl}
      >
        {target.text || m.subject_value_unlabelled({}, o)}
      </Link>
    );
  }
  // Only the native rank/language selection can use the page's authorized document body.
  if (
    part.value.type === 'value' &&
    part.property.data_type === 'document' &&
    (!part.id || pageDocumentReferences(read.public.subject, [part.property.id], locale)[0]?.candidate !== part.id)
  )
    return <span>{m.candidate_value_unavailable({}, o)}</span>;
  const content = part.value.type === 'value' ? part.value.content : undefined;
  const language =
    content && typeof content === 'object' && 'language' in content && typeof content.language === 'string'
      ? content.language
      : undefined;
  return (
    <div className="min-w-0 space-y-1">
      <CandidateValue
        snak={part}
        related={read.public.related}
        subject={read.public.subject.id}
        documents={documents}
        locale={locale}
        link={Link}
      />
      {language && <LanguageTag lang={language} locale={locale} />}
    </div>
  );
}
