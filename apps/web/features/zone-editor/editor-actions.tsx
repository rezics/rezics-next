'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import LocalizedLink from '../shell/localized-link.tsx';
import type { ZoneEditorMessages } from './messages.ts';

/**
 * One row at every width: Publish, then Save draft, then the two lighter ways out.
 * A full-width stack of these four pushed the writing area below a phone's fold.
 */
export function EditorActions({ copy, canEdit, busy, dirty, saveDisabled, publishDisabled, onSave, onPublish, previewHref, siteHref }: {
  copy: ZoneEditorMessages;
  canEdit: boolean;
  busy: null | 'save' | 'publish' | 'load';
  dirty: boolean;
  saveDisabled: boolean;
  publishDisabled: boolean;
  onSave: () => void;
  onPublish: () => void;
  previewHref: string;
  siteHref: string;
}) {
  return <div className="flex max-w-full min-w-0 flex-nowrap items-center gap-1 overflow-x-auto">
    {canEdit ? <>
      <Button size="sm" className="shrink-0" onClick={onPublish} disabled={publishDisabled} isLoading={busy === 'publish'}>
        {busy === 'publish' ? copy.publishing : copy.publish}
      </Button>
      <Button variant="secondary" size="sm" className="shrink-0" onClick={onSave} disabled={saveDisabled} isLoading={busy === 'save'}>
        {busy === 'save' ? copy.saving : copy.save}
      </Button>
    </> : null}
    <LocalizedLink href={previewHref} documentNavigation={dirty} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'shrink-0')}>
      {copy.preview}
    </LocalizedLink>
    <LocalizedLink href={siteHref} documentNavigation={dirty} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'shrink-0')}>
      {copy.viewSite}
    </LocalizedLink>
  </div>;
}
