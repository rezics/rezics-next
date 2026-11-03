import { buttonVariants } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { PartValue } from '../statement-editor-view';
import type { FactsCurrent } from '../subject-facts';
import { peopleBiographyHref, type PeopleBiographyField } from './index';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] md:pointer-fine:min-h-8 md:pointer-fine:min-w-0 md:pointer-fine:py-1';

/** Biography is the existing authored document, never a short description rewritten as long text. */
export function PeopleBiographyDocuments({
  field,
  read,
  locale,
  returnHref,
}: {
  field: PeopleBiographyField;
  read: FactsCurrent;
  locale: string;
  returnHref: string;
}) {
  const o = { locale: locale as never };
  const subject = read.public.subject;
  const title = Object.values(subject.labels)[0] ?? '';
  const href = peopleBiographyHref(subject.id, title, locale, field.editor === 'authored' ? field.id : undefined);
  return (
    <ContentItemFrame as="article" data-slot="people-biography" className="min-w-0 space-y-3 py-3 sm:py-4">
      <ContentItemHeading level={3} className="min-w-0 text-lg font-semibold" lang={field.label.lang ?? undefined}>
        {field.label.text || m.people_biography_title({}, o)}
      </ContentItemHeading>
      {field.description.text ? (
        <p className="text-sm text-muted-foreground" lang={field.description.lang ?? undefined}>
          {field.description.text}
        </p>
      ) : null}
      {field.status === 'unsupported' ? <p role="status">{m.people_biography_unsupported({}, o)}</p> : null}
      {field.status === 'absent' ? <p role="status">{m.people_biography_absent({}, o)}</p> : null}
      {field.status === 'unreadable' ? <p role="status">{m.people_biography_unreadable({}, o)}</p> : null}
      {field.facts.map((fact) => (
        <article key={fact.id} className="min-w-0 space-y-2">
          <PartValue part={fact.statement} read={read} locale={locale} />
          <p className="text-sm text-muted-foreground">
            {m.people_biography_document_id({}, o)} <code className="break-all">{fact.id}</code>
          </p>
        </article>
      ))}
      {field.editor === 'authored' ? (
        <a
          className={buttonVariants({ variant: 'outline', className: actionClass + ' self-start' })}
          href={`${href}${href.includes('?') ? '&' : '?'}return=${encodeURIComponent(returnHref)}`}
        >
          {m.people_biography_edit({}, o)}
        </a>
      ) : null}
      <a
        className={actionClass + ' inline-flex items-center underline'}
        href={subjectHref({ id: subject.id, label: title }, locale).href}
      >
        {m.people_biography_return({}, o)}
      </a>
    </ContentItemFrame>
  );
}
