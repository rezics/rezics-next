import type { ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { WideDocumentDescriptor } from './wide-document-reading';
import type { WideDocumentInspection } from './wide-document-inspector';

export function WideDocumentTable({
  descriptor,
  children,
  caption,
  language,
  direction,
  locale,
  onInspect,
}: {
  descriptor: WideDocumentDescriptor;
  children: ReactNode;
  caption?: string | undefined;
  language?: string | undefined;
  direction?: 'ltr' | 'rtl' | 'auto' | undefined;
  locale: string;
  onInspect: (inspection: WideDocumentInspection, trigger: HTMLButtonElement) => void;
}) {
  const options = { locale: locale as never };
  return (
    <section className="wide-document-table" data-slot="wide-document-table">
      <div className="wide-document-table-actions">
        <Button
          type="button"
          variant="outline"
          className="min-h-11 min-w-11 max-w-full whitespace-normal px-3 text-start [overflow-wrap:anywhere]"
          onClick={(event) =>
            onInspect({ kind: 'table', descriptor, children, caption, language, direction }, event.currentTarget)
          }
        >
          {m.wide_document_table_inspect({}, options)}
        </Button>
      </div>
      <div
        className="document-table-scroll wide-document-table-scroll"
        role="region"
        aria-label={m.wide_document_table_scroll({}, options)}
        tabIndex={0}
        lang={language}
        dir={direction}
      >
        <table>
          {caption !== undefined ? <caption>{caption}</caption> : null}
          <tbody>{children}</tbody>
        </table>
      </div>
    </section>
  );
}
