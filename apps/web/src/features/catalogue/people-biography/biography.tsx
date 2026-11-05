import { buttonVariants } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { m } from '../../../paraglide/messages.js';
import { defaultReader } from '../../../subject/reader';
import { spoilerLevel } from '../../pages/shared';
import { SpoilerGate } from '../../pages/values';
import { PartValue } from '../statement-editor-view';
import type { FactsCurrent } from '../subject-facts';
import { peopleBiographyFieldAnchor, peopleBiographyAssertionAnchor, PeopleBiographyAssertion } from './assertion';
import { peopleBiographyAddress as biographyAddress } from './current-visit';
import { peopleBiographyHref, peopleSubjectLabel, type PeopleBiographyField } from './index';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] md:pointer-fine:min-h-8 md:pointer-fine:min-w-0 md:pointer-fine:py-1';

/** Biography is the existing authored document, never a short description rewritten as long text. */
export function PeopleBiographyDocuments({
  field,
  read,
  locale,
  restoredAssertion,
}: {
  field: PeopleBiographyField;
  read: FactsCurrent;
  locale: string;
  restoredAssertion?: string | undefined;
}) {
  const o = { locale: locale as never };
  const subject = read.public.subject;
  const title = peopleSubjectLabel(subject, locale).text;
  const fallbackReturn = biographyAddress(subject.id, title, locale, subject.context, field.kind, field.id);
  const href = peopleBiographyHref(
    subject.id,
    title,
    locale,
    subject.context,
    fallbackReturn,
    field.editor === 'authored' ? field.id : undefined,
  );
  const authoredAction = (
    <a className={buttonVariants({ variant: 'outline', className: actionClass + ' self-start' })} href={href}>
      {m.people_biography_edit({}, o)}
    </a>
  );
  const associationHidden = field.facts.some((fact) => spoilerLevel(fact.statement) > defaultReader.spoilerLevel);
  return (
    <ContentItemFrame
      as="article"
      id={peopleBiographyFieldAnchor(field.id)}
      tabIndex={-1}
      data-slot="people-biography"
      className="min-w-0 space-y-3 py-3 sm:py-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
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
      {field.facts.map((fact) => {
        const content = (
          <article
            id={peopleBiographyAssertionAnchor(fact.id)}
            tabIndex={-1}
            className="min-w-0 space-y-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <PartValue part={fact.statement} read={read} locale={locale} />
            <p className="text-sm text-muted-foreground">
              {m.people_biography_document_id({}, o)} <code className="break-all">{fact.id}</code>
            </p>
            <PeopleBiographyAssertion
              fact={fact}
              field={field}
              read={read}
              locale={locale}
              title={title}
              restored={restoredAssertion === fact.id}
            />
          </article>
        );
        return (
          <section key={fact.id} className="min-w-0">
            {spoilerLevel(fact.statement) > defaultReader.spoilerLevel ? (
              <SpoilerGate
                label={m.subject_spoiler_show({}, o)}
                hideLabel={m.subject_spoiler_hide({}, o)}
                unmountOnHide
              >
                {content}
              </SpoilerGate>
            ) : (
              content
            )}
          </section>
        );
      })}
      {field.editor === 'authored' ? (
        associationHidden ? (
          <SpoilerGate label={m.subject_spoiler_show({}, o)} hideLabel={m.subject_spoiler_hide({}, o)} unmountOnHide>
            {authoredAction}
          </SpoilerGate>
        ) : (
          authoredAction
        )
      ) : null}
      <a className={actionClass + ' inline-flex items-center underline'} href={fallbackReturn}>
        {m.people_biography_return({}, o)}
      </a>
    </ContentItemFrame>
  );
}
