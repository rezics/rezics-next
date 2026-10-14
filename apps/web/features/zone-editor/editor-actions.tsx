'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import LocalizedLink from '../shell/localized-link.tsx';
import type { ZoneEditorMessages } from './messages.ts';

/**
 * One row at every width: Publish, then Save draft, then the two lighter ways out.
 * A full-width stack of these four pushed the writing area below a phone's fold.
 */
export function EditorActions({ copy, canEdit, canPublish = canEdit, busy, saveDisabled, publishDisabled, onSave, onPublish, previewHref, siteHref, canPreview = true }: {
  copy: ZoneEditorMessages;
  canEdit: boolean;
  canPublish?: boolean;
  canPreview?: boolean;
  busy: null | 'save' | 'publish' | 'load';
  saveDisabled: boolean;
  publishDisabled: boolean;
  onSave: () => void;
  onPublish: () => void;
  previewHref: string;
  siteHref: string;
}) {
  return <div className="flex max-w-full min-w-0 flex-nowrap items-center gap-1 overflow-x-auto">
    {canPublish ?
      <Button size="sm" className="shrink-0" onClick={onPublish} disabled={publishDisabled} isLoading={busy === 'publish'}>
        {busy === 'publish' ? copy.publishing : copy.publish}
      </Button> : null}
    {canEdit ?
      <Button variant="secondary" size="sm" className="shrink-0" onClick={onSave} disabled={saveDisabled} isLoading={busy === 'save'}>
        {busy === 'save' ? copy.saving : copy.save}
      </Button> : null}
    {/* Preview builds a fresh server selection; clean soft navigation could leave the editor segment mounted. */}
    {canPreview ? <LocalizedLink href={previewHref} documentNavigation className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'shrink-0')}>
      {copy.preview}
    </LocalizedLink> : null}
    <LocalizedLink href={siteHref} documentNavigation className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'shrink-0')}>
      {copy.viewSite}
    </LocalizedLink>
  </div>;
}
