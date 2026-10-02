'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@rezics/ui/dialog';
import { workCoverRatio } from '@rezics/ui/work-cover';
import { CircleCheckIcon, ImageUpIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { type ChangeEvent, lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { coverKindOf } from '../catalogue/work.ts';
import type { WorkCover as MainCover } from '../discover/types.ts';
import { UploadLimited, UploadStatus, useClearance } from '../safety/upload-status.tsx';
import type { Clearance } from '../safety/upload-state.ts';
import { type CoverOutcome, coverTypes, removeCover, uploadCover } from './cover-api.ts';
import type { StudioMessages } from './messages.ts';
import { StudioCover } from './studio-cover.tsx';
import { WebImageSettings } from '../document-editor/image-settings.tsx';

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

// The cropper (Zag's image cropper and its geometry) loads only once an author picks a picture.
const Cropper = lazy(() => import('./cover-cropper.tsx').then(module => ({ default: module.CoverCropper })));

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
  const [cropReady, setCropReady] = useState(false);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [current, setCurrent] = useState(cover);
  // The newest image's check: it shows to its uploader alone until Main clears it.
  const [uploaded, setUploaded] = useState<{ upload: string; clearance: Clearance } | null>(null);
  const [limited, setLimited] = useState<number | null>(null);
  const [rejected, setRejected] = useState(false);
  const clearance = useClearance(uploaded?.upload ?? null, uploaded?.clearance ?? null, send);
  useEffect(() => setCurrent(cover), [cover]);
  useEffect(() => () => { if (source) URL.revokeObjectURL(source.url); }, [source]);
  const kind = coverKindOf(work.types);
  const ratio = workCoverRatio[kind];
  const selection = current?.kind === 'image' ? current.selection : null;
  const close = () => { crop.current = null; setCropReady(false); setSource(null); };
  const ready = useCallback((value: () => Promise<Blob | null>) => {
    crop.current = value;
    setCropReady(true);
  }, []);

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    setResult(null);
    if (!file) return;
    if (!(coverTypes as readonly string[]).includes(file.type)) { setResult({ ok: false, message: t.coverUnsupported }); return; }
    const url = URL.createObjectURL(file);
    crop.current = null;
    setCropReady(false);
    void measure(url).then(measured => {
      if (measured) setSource(measured);
      else { URL.revokeObjectURL(url); setResult({ ok: false, message: t.coverUnsupported }); }
    });
  };
  const message = (outcome: Exclude<CoverOutcome['outcome'], 'done' | 'limited' | 'rejected'>) => outcome === 'denied' ? t.coverDenied
    : outcome === 'too-large' ? t.coverTooLarge : outcome === 'unsupported' ? t.coverUnsupported : t.coverFailed;
  /** Says what a refused upload means: a spent budget, an image not accepted, or what went wrong. */
  const refuse = (outcome: Exclude<CoverOutcome, { outcome: 'done' }>) => {
    // Both are answers to the image, not to the framing, and the dialog would hide them: close it.
    if (outcome.outcome === 'limited') { close(); setLimited(outcome.retryAfter); setResult(null); return; }
    if (outcome.outcome === 'rejected') { close(); setUploaded(null); setResult(null); setRejected(true); return; }
    setResult({ ok: false, message: message(outcome.outcome) });
  };
  const save = async () => {
    if (!cropReady || !crop.current) return;
    setBusy('upload');
    setLimited(null); setRejected(false);
    const image = await crop.current().catch(() => null);
    const outcome = image ? await uploadCover({ actingSubject: agent.iri, work: work.id, image, expected: selection,
      key: crypto.randomUUID() }, send) : { outcome: 'failed' as const };
    setBusy(null);
    if (outcome.outcome === 'done') {
      close();
      setUploaded(outcome.upload && outcome.clearance ? { upload: outcome.upload, clearance: outcome.clearance } : null);
      setResult({ ok: true, message: t.coverSaved });
      router.refresh();
    } else refuse(outcome);
  };
  const remove = async () => {
    setBusy('remove');
    const outcome = await removeCover({ actingSubject: agent.iri, work: work.id, expected: selection,
      key: crypto.randomUUID() }, send);
    setBusy(null);
    if (outcome.outcome === 'done') {
      setCurrent(null); setUploaded(null);
      setResult({ ok: true, message: t.coverRemoved });
      router.refresh();
    } else refuse(outcome);
  };

  return <section aria-labelledby={`${inputId}-heading`} className="grid content-start gap-4">
    <div className="grid gap-1">
      <h3 id={`${inputId}-heading`} className="font-semibold">{t.coverHeading}</h3>
      <p className="text-muted-foreground text-sm">{t.coverHelp}</p>
    </div>
    <div className="flex items-end gap-4">
      <StudioCover id={work.id} title={work.title} cover={current} types={work.types} actingSubject={agent.iri}
        authors={agent.label ? [agent.label] : []} size="md" />
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
    {clearance ? <UploadStatus clearance={clearance} locale={locale} /> : null}
    {rejected ? <UploadStatus clearance="rejected" locale={locale} /> : null}
    {limited !== null ? <UploadLimited retryAfter={limited} locale={locale} /> : null}
    {current?.kind === 'image' ? <WebImageSettings src={current.url} actingSubject={agent.iri} locale={locale} send={send} /> : null}
    <Dialog open={source !== null} onOpenChange={details => { if (!details.open && busy === null) close(); }}>
      <DialogContent size="md">
        <DialogHeader title={t.cropHeading} description={t.cropHelp} />
        <DialogBody>
          {source ? <Suspense fallback={<div aria-hidden="true" className="mx-auto w-full rounded-2xl bg-muted"
            style={{ aspectRatio: String(source.width / source.height), maxWidth: `min(100%, calc(60dvh * ${source.width / source.height}))` }} />}>
            <Cropper source={source} ratio={ratio} label={t.cropLabel} onReady={ready} />
          </Suspense> : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={busy !== null}>{t.cancel}</Button>
          <Button type="button" onClick={() => void save()} isLoading={busy === 'upload'} disabled={busy !== null || !cropReady}>
            {busy === 'upload' ? t.savingCover : t.saveCover}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
