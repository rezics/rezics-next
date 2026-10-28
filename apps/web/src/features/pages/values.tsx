import { checkDocument, type DocumentSnapshot } from '@rezics/document';
import { Cover, type CoverRatio, type CoverSubject, type CoverSummary } from '@rezics/ui/cover';
import { DocumentBody } from '@rezics/ui/document-body';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@rezics/ui/shadcn/collapsible';
import { Eye } from 'lucide-react';
import type { ReactNode } from 'react';
import { coverSrc } from '../../media/cover-src';
import { foreignLanguageName } from '../../subject/language';

export const SPOILER_PROPERTY = 'rezics:spoilerLevel';

/** The strings the value views need; the page supplies them in the reader's language. */
export type ValueLabels = {
  spoilerShow: string;
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
export function SpoilerGate({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Collapsible className="space-y-2">
      <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
        <Eye aria-hidden="true" className="size-4" />
        {label}
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
  labels,
}: {
  document: DocumentSnapshot;
  lang: string | undefined;
  labels: ValueLabels;
}) {
  return (
    <div lang={lang} className="max-w-prose">
      <DocumentBody document={document} labels={{ revealSpoiler: labels.documentSpoiler }} />
    </div>
  );
}
