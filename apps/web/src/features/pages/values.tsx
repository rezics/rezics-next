import { checkDocument, type DocumentSnapshot } from '@rezics/document';
import { Cover, type CoverRatio, type CoverSubject, type CoverSummary } from '@rezics/ui/cover';
import { DocumentBody } from '../../document-body';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@rezics/ui/shadcn/collapsible';
import { Eye } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { m } from '../../paraglide/messages.js';
import { coverSrc } from '../../media/cover-src';
import { foreignLanguageName } from '../../subject/language';

export const SPOILER_PROPERTY = 'rezics:spoilerLevel';

/** The strings the value views need; the page supplies them in the reader's language. */
export type ValueLabels = {
  spoilerShow: string;
  spoilerHide?: string;
  documentSpoiler: string;
  cover: { withheld: string; reveal: string; credit: string; via: string };
};

/** Text in a language other than the reader's carries a quiet tag naming that language in the reader's words. */
export function LanguageTag({ lang, locale }: { lang: string | null | undefined; locale: string }) {
  const name = foreignLanguageName(lang, locale);
  if (name === undefined) return null;
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      {name}
    </Badge>
  );
}

/** Content above the reader's spoiler level; the panel is not rendered until it is opened. */
export function SpoilerGate({
  label,
  hideLabel,
  children,
}: {
  label: string;
  hideLabel?: string | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-2">
      <CollapsibleTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 min-w-11 whitespace-normal text-left focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-4"
          />
        }
      >
        <Eye aria-hidden="true" className="size-4" />
        {open ? (hideLabel ?? m.subject_spoiler_hide()) : label}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** A media value is an image, drawn through `Cover`; without a summary for it the frame shows its placeholder. */
export function MediaValue({
  subject,
  cover,
  ratio,
  suitability,
  labels,
}: {
  subject: CoverSubject;
  cover: CoverSummary | null;
  ratio?: CoverRatio;
  suitability: 'blur' | 'show';
  labels: ValueLabels['cover'];
}) {
  return (
    <Cover
      subject={subject}
      cover={cover}
      size="md"
      src={coverSrc}
      suitability={suitability}
      labels={labels}
      {...(ratio ? { ratio } : {})}
    />
  );
}

/** A document value is the document itself, set as prose; a malformed one is not presentable. */
export function readableDocument(value: unknown): DocumentSnapshot | undefined {
  return checkDocument(value) ? value : undefined;
}

export function DocumentValue({
  document,
  lang,
  locale,
  labels,
}: {
  document: DocumentSnapshot;
  lang: string | undefined;
  /** Reader-interface locale for embedded controls; authored `lang` stays the document language. */
  locale?: string;
  labels: ValueLabels;
}) {
  return (
    <div lang={lang} className="max-w-prose">
      <DocumentBody document={document} locale={locale} labels={{ revealSpoiler: labels.documentSpoiler }} />
    </div>
  );
}
