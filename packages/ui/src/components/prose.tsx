import type { ComponentProps } from 'react';
import { cn } from '../utils.ts';

export interface ProseProps extends ComponentProps<'div'> {
  /**
   * Cap the line length at a readable measure and centre the column. Turn it off where the surrounding layout already
   * sets the width, such as an editor inside a form.
   *
   * @default true
   */
  measure?: boolean;
}

/**
 * The surface member-written documents are drawn on, in the reading page and in the editor. shadcn has no typography
 * primitive, so the styles live in `prose.css`: interface-face body text, a measure of about 65 characters (36 em for
 * Chinese, Japanese and Korean), more leading for CJK scripts, and the serif face only under `.work-title`.
 */
export function Prose({ className, measure = true, ...props }: ProseProps) {
  return (
    <div
      data-slot="prose"
      data-measure={measure ? '' : undefined}
      className={cn('rezics-document text-foreground', measure && 'mx-auto max-w-[65ch]', className)}
      {...props}
    />
  );
}
