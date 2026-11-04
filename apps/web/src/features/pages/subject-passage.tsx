import type { ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';

type Excerpt = { text: string; complete: boolean };

/** Stop at a grapheme boundary within 420 code units and before the third paragraph. */
function descriptionExcerpt(text: string): Excerpt {
  let end = 0;
  for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (index + segment.length > 420) break;
    end = index + segment.length;
  }
  const prefix = text.slice(0, end);
  const paragraphs = prefix.matchAll(/(?:\r?\n|\r(?!\n))[\t ]*(?:\r?\n|\r(?!\n))(?:[\t ]*(?:\r?\n|\r(?!\n)))*/g);
  paragraphs.next();
  const third = paragraphs.next().value;
  if (third) end = third.index;
  const complete = end === text.length;
  return { text: complete ? text : text.slice(0, end).trimEnd(), complete };
}

/** Native disclosure hides the excerpt when open and keeps one intact body available without JavaScript. */
export function SubjectPassage({
  excerpt,
  language,
  locale,
  children,
  open,
  onOpenChange,
}: {
  excerpt: Excerpt;
  language: string | undefined;
  locale: string;
  children: ReactNode;
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}) {
  if (excerpt.complete) return children;
  const options = { locale: locale as never };
  return (
    <details
      data-slot="summary-disclosure"
      className="group space-y-3"
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onToggle: (event) => onOpenChange(event.currentTarget.open) } : {})}
    >
      <summary className="min-h-11 min-w-11 cursor-pointer rounded-sm py-2 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-4">
        {excerpt.text && (
          <span
            lang={language}
            className="mb-2 block max-w-prose text-pretty leading-7 whitespace-pre-wrap [overflow-wrap:anywhere] group-open:hidden"
          >
            {excerpt.text}…
          </span>
        )}
        <span className="text-sm font-medium text-primary underline underline-offset-4 group-open:hidden">
          {m.subject_summary_expand({}, options)}
        </span>
        <span className="hidden text-sm font-medium text-primary underline underline-offset-4 group-open:inline">
          {m.subject_summary_collapse({}, options)}
        </span>
      </summary>
      {children}
    </details>
  );
}

export function DescriptionPassage({
  text,
  language,
  locale,
}: {
  text: string;
  language: string | undefined;
  locale: string;
}) {
  return (
    <SubjectPassage excerpt={descriptionExcerpt(text)} language={language} locale={locale}>
      <p lang={language} className="max-w-prose text-pretty leading-7 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {text}
      </p>
    </SubjectPassage>
  );
}
