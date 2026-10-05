import { checkDocument, hasDocumentContent } from '@rezics/document';
import { DocumentBody } from '@rezics/ui/document-body';
import { interfaceDirection, type UiLocale } from '../../i18n/define.ts';
import { messages as documentMessages } from '../document-editor/messages.ts';

/** A Post augmentation has no chapter paragraph positions or text-rating target. */
export function AuthorNote({ value, side, label, locale }: {
  value: unknown; side: 'before' | 'after'; label: string; locale: UiLocale;
}) {
  if (!value || typeof value !== 'object') return null;
  const note = value as { body?: unknown; document?: unknown };
  const document = checkDocument(note.document) ? note.document : null;
  if (document ? !hasDocumentContent(document) : typeof note.body !== 'string' || !note.body.trim()) return null;
  return <aside role="note" aria-label={label} data-author-note={side}
    className="grid gap-3 rounded-xl border-s-2 border-border bg-muted/30 p-4 sm:p-5">
    <h2 lang={locale} dir={interfaceDirection[locale]} className="font-medium text-muted-foreground text-sm">{label}</h2>
    <div className="grid gap-2 text-base/[1.7] [overflow-wrap:anywhere]">
      {document ? <DocumentBody document={document}
        className="font-sans! text-base! leading-[1.7]!"
        unknownComponentLabel={documentMessages[locale].unknownComponent}
        spoilerLabel={documentMessages[locale].revealSpoiler} />
        : <p className="whitespace-pre-wrap">{String(note.body)}</p>}
    </div>
  </aside>;
}
