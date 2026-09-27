'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { ImageCropperImage, ImageCropperRootProvider, ImageCropperSelection, useImageCropper }
  from '@rezics/ui/image-cropper';
import { workCoverRatio } from '@rezics/ui/work-cover';
import { CircleCheckIcon, ImageUpIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { type ChangeEvent, useEffect, useId, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { coverKindOf } from '../catalogue/work.ts';
import type { WorkCover as MainCover } from '../discover/types.ts';
import { COVER_MAX_BYTES, type CoverOutcome, coverTypes, removeCover, uploadCover } from './cover-api.ts';
import type { StudioMessages } from './messages.ts';
import { StudioCover } from './studio-cover.tsx';

export interface CoverEditorProps {
  agent: AgentOption;
  work: { id: string; title: { value: string; language: string }; types: readonly string[] };
  /** The cover readers see now. */
  cover: MainCover | null;
  locale: UiLocale;
  messages: StudioMessages;
  /** Stories pass a stand-in for Main's upload and selection. */
  send?: typeof fetch;
}

// The longest side Studio sends; readers get at most 2048 px, and a cover is shown far smaller.
const LONG_SIDE = 1800;

function Cropper({ source, ratio, label, onReady }: {
  source: { url: string; width: number; height: number }; ratio: number; label: string;
  onReady: (crop: () => Promise<Blob | null>) => void;
}) {
  const cropper = useImageCropper({ aspectRatio: ratio });
  useEffect(() => {
    onReady(async () => {
      const size = ratio >= 1 ? { width: LONG_SIDE, height: Math.round(LONG_SIDE / ratio) }
        : { width: Math.round(LONG_SIDE * ratio), height: LONG_SIDE };
      for (const quality of [0.9, 0.8, 0.7]) {
        const image = await cropper.getCroppedImage({ type: 'image/jpeg', quality, maxSize: size, output: 'blob' });
        if (!(image instanceof Blob)) return null;
        if (image.size <= COVER_MAX_BYTES) return image;
      }
      return null;
    });
  }, [cropper, ratio, onReady]);
  // The frame takes the picture's own proportions, so the picture is never stretched; tall pictures fit the screen.
  const shape = source.width / source.height;
  return <ImageCropperRootProvider value={cropper} aria-label={label} className="mx-auto rounded-2xl bg-muted"
    style={{ aspectRatio: String(shape), maxWidth: `min(100%, calc(60dvh * ${shape}))` }}>
    <ImageCropperImage src={source.url} alt="" />
    <ImageCropperSelection />
  </ImageCropperRootProvider>;
}

/** The picture's size, read before framing it. */
function measure(url: string): Promise<{ url: string; width: number; height: number } | null> {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth && image.naturalHeight
      ? { url, width: image.naturalWidth, height: image.naturalHeight } : null);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/**
 * The Work's cover: the one readers see, a new image framed to the cover's
 * proportions before it is sent, or back to the generated cover. Studio sends
 * only the framed part, scaled to what readers are shown.
 */
export function CoverEditor({ agent, work, cover, locale, messages, send }: CoverEditorProps) {
  const t = materializeData(messages, { locale });
  const router = useRouter();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const crop = useRef<(() => Promise<Blob | null>) | null>(null);
  const [source, setSource] = useState<{ url: string; width: number; height: number } | null>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [current, setCurrent] = useState(cover);
  useEffect(() => setCurrent(cover), [cover]);
  useEffect(() => () => { if (source) URL.revokeObjectURL(source.url); }, [source]);
  const kind = coverKindOf(work.types);
  const ratio = workCoverRatio[kind];
  const selection = current?.kind === 'image' ? current.selection : null;

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setResult(null);
    if (!file) return;
    if (!(coverTypes as readonly string[]).includes(file.type)) { setResult({ ok: false, message: t.coverUnsupported }); return; }
    const url = URL.createObjectURL(file);
    void measure(url).then(measured => {
      if (measured) setSource(measured);
      else { URL.revokeObjectURL(url); setResult({ ok: false, message: t.coverUnsupported }); }
    });
  };
  const message = (outcome: CoverOutcome['outcome']) => outcome === 'denied' ? t.coverDenied
    : outcome === 'too-large' ? t.coverTooLarge : outcome === 'unsupported' ? t.coverUnsupported : t.coverFailed;
  const save = async () => {
    setBusy('upload');
    const image = await crop.current?.().catch(() => null);
    const outcome = image ? await uploadCover({ actingSubject: agent.iri, work: work.id, image, expected: selection,
      key: crypto.randomUUID() }, send) : { outcome: 'failed' as const };
    setBusy(null);
    if (outcome.outcome === 'done') {
      setSource(null);
      setResult({ ok: true, message: t.coverSaved });
      router.refresh();
    } else setResult({ ok: false, message: message(outcome.outcome) });
  };
  const remove = async () => {
    setBusy('remove');
    const outcome = await removeCover({ actingSubject: agent.iri, work: work.id, expected: selection,
      key: crypto.randomUUID() }, send);
    setBusy(null);
    if (outcome.outcome === 'done') {
      setCurrent(null);
      setResult({ ok: true, message: t.coverRemoved });
      router.refresh();
    } else setResult({ ok: false, message: message(outcome.outcome) });
  };

  return <section aria-labelledby={`${inputId}-heading`} className="grid content-start gap-4">
    <div className="grid gap-1">
      <h3 id={`${inputId}-heading`} className="font-semibold">{t.coverHeading}</h3>
      <p className="text-muted-foreground text-sm">{t.coverHelp}</p>
    </div>
    <div className="flex items-end gap-4">
      <StudioCover id={work.id} title={work.title} cover={current} types={work.types} actingSubject={agent.iri} size="md" />
      <div className="grid gap-2">
        <input ref={input} id={inputId} type="file" accept={coverTypes.join(',')} className="sr-only" onChange={choose}
          aria-label={t.chooseCover} />
        <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()} disabled={busy !== null}>
          <ImageUpIcon aria-hidden="true" />{selection ? t.replaceCover : t.chooseCover}</Button>
        {current?.kind === 'image' ? <Button type="button" variant="ghost" size="sm" onClick={() => void remove()}
          disabled={busy !== null} isLoading={busy === 'remove'}><XIcon aria-hidden="true" />{t.removeCover}</Button> : null}
      </div>
    </div>
    {result ? result.ok ? <p role="status" className="flex items-center gap-2 text-sm text-success-foreground">
      <CircleCheckIcon aria-hidden="true" className="size-4" />{result.message}</p>
      : <Alert variant="destructive"><TriangleAlertIcon aria-hidden="true" />
        <AlertDescription role="alert" className="text-destructive-foreground">{result.message}</AlertDescription></Alert>
      : null}
    <Dialog open={source !== null} onOpenChange={details => { if (!details.open && busy === null) setSource(null); }}>
      <DialogContent size="md">
        <DialogHeader title={t.cropHeading} description={t.cropHelp} />
        <DialogBody>
          {source ? <Cropper source={source} ratio={ratio} label={t.cropLabel}
            onReady={value => { crop.current = value; }} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setSource(null)} disabled={busy !== null}>{t.cancel}</Button>
          <Button type="button" onClick={() => void save()} isLoading={busy === 'upload'} disabled={busy !== null}>
            {busy === 'upload' ? t.savingCover : t.saveCover}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
