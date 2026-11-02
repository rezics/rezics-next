import type { SubjectRead } from '@rezics/client';
import { ContentItemFrame, ContentItemHeading, ContentItemTitleLink } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import { pageText } from '../pages/shared';

const referenceActionClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:min-w-8 md:pointer-fine:py-0';

export function FictionalReferenceDetails({
  id,
  type,
  work = false,
  locale,
}: {
  id?: string | undefined;
  type: string;
  work?: boolean;
  locale: string;
}) {
  const o = { locale: locale as never };
  return (
    <details className="min-w-0 text-sm">
      <summary className={`${referenceActionClass} cursor-pointer text-muted-foreground`}>
        {m.fictional_work_technical_details({}, o)}
      </summary>
      <dl className="min-w-0 space-y-3 py-2">
        {id && (
          <div className="min-w-0">
            <dt className="text-muted-foreground">
              {work ? m.fictional_work_work_reference({}, o) : m.fictional_work_subject_reference({}, o)}
            </dt>
            <dd className="min-w-0">
              <code
                tabIndex={0}
                className="block max-w-full select-text whitespace-pre-wrap [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-ring"
              >
                {id}
              </code>
            </dd>
          </div>
        )}
        <div className="min-w-0">
          <dt className="text-muted-foreground">{m.fictional_work_type_reference({}, o)}</dt>
          <dd className="min-w-0">
            <code
              tabIndex={0}
              className="block max-w-full select-text whitespace-pre-wrap [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-ring"
            >
              {type}
            </code>
          </dd>
        </div>
      </dl>
    </details>
  );
}

/** Supplied current identity only; the adjacent editor keeps its own mount and exact key. */
export function FictionalWorkReference({
  subject,
  locale,
  onChooseAnother,
}: {
  subject: Pick<SubjectRead['subject'], 'id' | 'type' | 'labels'>;
  locale: string;
  onChooseAnother?: (() => void) | undefined;
}) {
  const o = { locale: locale as never };
  const label = pageText(subject.labels, locale);
  return (
    <ContentItemFrame as="div" className="min-w-0 space-y-2 py-3" data-slot="fictional-work-reference">
      <ContentItemHeading
        level={3}
        lang={label.lang}
        className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere]"
      >
        <ContentItemTitleLink
          stretch={false}
          href={subjectHref({ id: subject.id, label: label.text }, locale).href}
          lang={label.lang}
          className={`${referenceActionClass} underline`}
        >
          {label.text || m.subject_value_unlabelled({}, o)}
        </ContentItemTitleLink>
      </ContentItemHeading>
      <FictionalReferenceDetails id={subject.id} type={subject.type} work locale={locale} />
      {onChooseAnother && (
        <Button type="button" variant="outline" className={referenceActionClass} onClick={onChooseAnother}>
          {m.fictional_work_choose_another({}, o)}
        </Button>
      )}
    </ContentItemFrame>
  );
}
