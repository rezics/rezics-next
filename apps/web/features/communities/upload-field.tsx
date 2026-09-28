'use client';

import { FileUpload, FileUploadDescription, FileUploadDropzone, FileUploadDropzoneIcon,
  FileUploadHelper, FileUploadList, FileUploadTitle } from '@rezics/ui/file-upload';
import { ImageIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { communityText as words } from './messages.ts';

export function CommunityUploadField({ kind, locale, file, onChange }: { kind: 'icon' | 'banner';
  locale: UiLocale; file: File | null; onChange: (file: File | null) => void }) {
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
    <p className="text-muted-foreground text-xs">{words.imageHelp[locale]}</p>
  </div>;
}
