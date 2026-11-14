import { useId } from 'react';
import { FileText } from 'lucide-react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { StudioDocument } from './contract';
import './studio-navigation.css';

/** Book's unplaced drafts and Column's articles share document navigation, not release selection. */
export function StudioDraftNavigation({
  documents,
  activePostId,
  disabled,
  onOpen,
}: {
  documents: readonly StudioDocument[];
  activePostId: string | null;
  disabled: boolean;
  onOpen: (postId: string) => void;
}) {
  return (
    <ol className="studio-navigation-branch">
      {documents.map((document) => (
        <DraftEntry
          key={document.postId}
          document={document}
          active={activePostId === document.postId}
          disabled={disabled}
          onOpen={onOpen}
        />
      ))}
    </ol>
  );
}

function DraftEntry({
  document,
  active,
  disabled,
  onOpen,
}: {
  document: StudioDocument;
  active: boolean;
  disabled: boolean;
  onOpen: (postId: string) => void;
}) {
  const id = useId();
  const options = { locale: getLocale() };
  const title =
    document.title.trim() ||
    (document.openable === false
      ? m.own_drafts_selection_unavailable({}, options)
      : m.own_drafts_no_title({}, options));
  const status =
    document.openable === false
      ? m.studio_account_continue_drafts({}, options)
      : document.state === 'published'
        ? m.studio_workspace_published_document({}, options)
        : document.state === 'protected'
          ? m.studio_workspace_protected_document({}, options)
          : document.state === 'taken_down'
            ? m.studio_workspace_taken_down({}, options)
            : m.studio_workspace_private_draft({}, options);
  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        className="studio-navigation-row"
        aria-current={active ? 'page' : undefined}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-status`}
        disabled={disabled || document.openable === false}
        onClick={() => onOpen(document.postId)}
      >
        <FileText aria-hidden="true" />
        <span className="studio-navigation-document-copy">
          <span id={`${id}-title`}>{title}</span>
          <span id={`${id}-status`} className="studio-navigation-document-state">
            {status}
          </span>
        </span>
      </Button>
    </li>
  );
}
