'use client';

import { FileUpload, FileUploadDescription, FileUploadDropzone, FileUploadDropzoneIcon,
  FileUploadHelper, FileUploadList, FileUploadTitle } from '@rezics/ui/file-upload';
import { ImageIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { Clearance } from '../safety/upload-state.ts';
import { UploadLimited, UploadStatus } from '../safety/upload-status.tsx';
import { communityText as words } from './messages.ts';

/** What happened to the image once it was sent: its check, or a spent upload budget. */
export type UploadOutcome = { clearance: Clearance } | { limited: number } | null;

export function CommunityUploadField({ kind, locale, file, onChange, outcome = null }: { kind: 'icon' | 'banner';
  locale: UiLocale; file: File | null; onChange: (file: File | null) => void; outcome?: UploadOutcome }) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <div className="grid min-w-0 gap-2">
    <p className="text-sm font-medium">{words[kind][locale]}</p>
    <FileUpload accept="image/jpeg,image/png,image/webp" maxFiles={1} maxFileSize={4 * 1024 * 1024}
      onFileChange={details => onChange(details.acceptedFiles[0] ?? null)}>
      <FileUploadDropzone aria-label={words[kind][locale]} className="min-h-40 p-4">
        {preview ? <img src={preview} alt="" className={kind === 'icon'
          ? 'size-20 rounded-full object-cover' : 'h-20 w-48 rounded-lg object-cover'} />
          : <FileUploadDropzoneIcon><ImageIcon aria-hidden="true" /></FileUploadDropzoneIcon>}
        <FileUploadTitle>{words.imageDrop[locale]}</FileUploadTitle>
        <FileUploadDescription>{words.imageChoose[locale]}</FileUploadDescription>
        <FileUploadHelper>{words[kind === 'icon' ? 'iconCrop' : 'bannerCrop'][locale]}</FileUploadHelper>
      </FileUploadDropzone>
      <FileUploadList />
    </FileUpload>
    {outcome && 'clearance' in outcome ? <UploadStatus clearance={outcome.clearance} locale={locale} />
      : outcome ? <UploadLimited retryAfter={outcome.limited} locale={locale} /> : null}
    <p className="text-muted-foreground text-xs">{words.imageHelp[locale]}</p>
  </div>;
}
