'use client';

import { useState } from 'react';
import { Button } from './button.tsx';
import { Checkbox } from './checkbox.tsx';
import { useMediaImageLabels, type ImageAgeRating, type MediaImageMetadata } from './media-image.tsx';
import { NativeSelect, NativeSelectOption } from './native-select.tsx';

export type ImageLabelEditor = (change: {
  metadata: MediaImageMetadata;
  field: 'nsfw' | 'ageRating' | 'conceal';
  value: MediaImageMetadata['nsfw'] | ImageAgeRating | boolean;
  mode: 'edit' | 'lock' | 'unlock';
}) => Promise<MediaImageMetadata>;

export class ImageLabelEditError extends Error {
  constructor(readonly current?: MediaImageMetadata) { super('image-setting-not-saved'); }
}

/** The same independent image fields and platform controls serve document images, covers and avatars. */
export function ImageSettings({ metadata, onEditImageLabels: edit, conceal: authoredConceal = false, onConcealChange, onMetadataChange, localConceal = false }: {
  metadata?: MediaImageMetadata; onEditImageLabels?: ImageLabelEditor;
  conceal?: boolean; onConcealChange?: (value: boolean) => void;
  onMetadataChange?: (value: MediaImageMetadata) => void;
  /** Only legacy external links edit a local flag; managed Uses always call their owner. */
  localConceal?: boolean;
}) {
  const labels = useMediaImageLabels();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const conceal = metadata?.mediaUseId ? Boolean(metadata.conceal) : authoredConceal || Boolean(metadata?.conceal);
  async function change(field: 'nsfw' | 'ageRating' | 'conceal', value: MediaImageMetadata['nsfw'] | ImageAgeRating | boolean, mode: 'edit' | 'lock' | 'unlock' = 'edit') {
    if (field === 'conceal' && localConceal && mode === 'edit') { onConcealChange?.(value as boolean); return; }
    if (!metadata || !edit) return;
    setBusy(true); setFailed(false);
    try {
      const next = await edit({ metadata, field, value, mode });
      onMetadataChange?.(next);
      if (field === 'conceal') onConcealChange?.(Boolean(next.conceal));
    } catch (error) {
      if (error instanceof ImageLabelEditError && error.current) onMetadataChange?.(error.current);
      setFailed(true);
    }
    finally { setBusy(false); }
  }
  const disabled = (field: 'nsfw' | 'ageRating' | 'conceal') => {
    const control = metadata?.controls?.[field];
    return busy || (field === 'conceal' && localConceal ? !onConcealChange
      : !edit || !control || !control.canProtect && (!control.canEdit || control.locked));
  };
  function protection(field: 'nsfw' | 'ageRating' | 'conceal', value: MediaImageMetadata['nsfw'] | ImageAgeRating | boolean) {
    const control = metadata?.controls?.[field];
    if (!control) return null;
    return <>
      {control.locked ? <span className="order-last basis-full text-xs text-muted-foreground">{labels.locked}</span> : null}
      {edit && control.canProtect ? <Button type="button" size="xs" variant="outline" disabled={busy}
        aria-label={`${control.locked ? labels.unlock : labels.lock} ${field === 'nsfw' ? labels.nsfwLabel : field === 'ageRating' ? labels.ageRating : labels.conceal}`}
        onClick={() => void change(field, value, control.locked ? 'unlock' : 'lock')}>{control.locked ? labels.unlock : labels.lock}</Button> : null}
    </>;
  }
  const rating = metadata?.ageRating ?? { status: 'unassessed' as const };
  const ageValue = rating.status === 'unassessed' ? 'unassessed' : rating.labels.join(',') || 'general';
  return <div contentEditable={false} className="grid gap-3 rounded-lg border border-border/60 bg-popover p-3 font-sans text-sm" data-slot="image-settings">
    {metadata?.mediaUseId || onConcealChange ? <div className="flex flex-wrap items-center gap-2">
      <Checkbox checked={conceal} disabled={disabled('conceal')} onCheckedChange={({ checked }) => void change('conceal', checked === true)}>{labels.conceal}</Checkbox>
      {protection('conceal', conceal)}
    </div> : null}
    {metadata ? <>
      <div className="flex flex-wrap items-center gap-2"><label className="flex min-w-0 flex-1 items-center gap-2">{labels.nsfwLabel}
        <NativeSelect size="sm" value={metadata.nsfw} disabled={disabled('nsfw')} onChange={event => void change('nsfw', event.target.value as MediaImageMetadata['nsfw'])}>
          <NativeSelectOption value="unknown">{labels.unassessed}</NativeSelectOption><NativeSelectOption value="sfw">{labels.sfw}</NativeSelectOption><NativeSelectOption value="nsfw">{labels.nsfwLabel}</NativeSelectOption>
        </NativeSelect></label>{protection('nsfw', metadata.nsfw)}
      </div>
      <div className="flex flex-wrap items-center gap-2"><label className="flex min-w-0 flex-1 items-center gap-2">{labels.ageRating}
        <NativeSelect size="sm" value={ageValue} disabled={disabled('ageRating')} onChange={event => void change('ageRating', event.target.value === 'unassessed'
          ? { status: 'unassessed' } : { status: 'assessed', labels: event.target.value === 'general' ? [] : event.target.value.split(',') as ('r15' | 'r18' | 'r18g')[] })}>
          <NativeSelectOption value="unassessed">{labels.unassessed}</NativeSelectOption><NativeSelectOption value="general">{labels.general}</NativeSelectOption>
          <NativeSelectOption value="r15">R15</NativeSelectOption><NativeSelectOption value="r18">R18</NativeSelectOption>
          <NativeSelectOption value="r18g">R18G</NativeSelectOption><NativeSelectOption value="r18,r18g">R18 + R18G</NativeSelectOption>
        </NativeSelect></label>{protection('ageRating', rating)}
      </div>
    </> : null}
    {failed ? <p role="alert" className="text-xs text-destructive">{labels.saveFailed}</p> : null}
  </div>;
}
