import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { FileTextIcon } from 'lucide-react';
import type { DocumentSnapshot } from '@rezics/document';
import { EmptyState } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { ZoneHomeDocument } from './home-document.tsx';
import type { ZoneEditorMessages } from './messages.ts';

const linkClass = 'h-auto min-h-9 w-full whitespace-normal sm:w-auto';

/** The saved draft, as readers will see it. Unsaved keystrokes are not part of this view. */
export function ZoneDraftPreview({ copy, document, editorPath, sitePath, status }: {
  copy: ZoneEditorMessages;
  document: DocumentSnapshot | null;
  editorPath: string;
  sitePath: string;
  status: 'private' | 'live' | 'behind';
}) {
  const statusText = status === 'live' ? copy.statusLive : status === 'behind' ? copy.statusBehind : copy.statusPrivate;
  return <section className="grid min-w-0 gap-4" aria-labelledby="zone-draft-preview">
    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-2">
        <h2 id="zone-draft-preview" className="font-semibold text-xl tracking-tight">{copy.previewTitle}</h2>
        <p className="max-w-2xl text-pretty text-muted-foreground text-sm">{copy.previewHelp}</p>
        <p className="text-sm" role="status">{statusText}</p>
      </div>
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
        <LocalizedLink href={editorPath} className={cn(buttonVariants({ variant: 'outline' }), linkClass)}>{copy.backToEditor}</LocalizedLink>
        <LocalizedLink href={sitePath} className={cn(buttonVariants({ variant: 'outline' }), linkClass)}>{copy.viewSite}</LocalizedLink>
      </div>
    </div>
    {document
      ? <ZoneHomeDocument document={document} className="max-w-3xl text-pretty leading-7" />
      : <EmptyState icon={FileTextIcon} title={copy.previewEmptyTitle} description={copy.previewEmptyBody} headingLevel={3} />}
  </section>;
}
