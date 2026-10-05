'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { EyeOffIcon } from 'lucide-react';
import { cn } from '../utils.ts';
import { Button } from './button.tsx';
import { safeDocumentUrl } from './document-url.tsx';
import { mediaImageKey } from './media-image-key.tsx';

export interface MediaImageViewer {
  ready: boolean;
  signedIn: boolean;
  age: 'unknown' | 'under-15' | '15-17' | 'adult';
  optIns: { general: boolean; r15: boolean; sexual: boolean; grotesque: boolean };
  nsfwDisplay?: 'mask' | 'show';
}
export type ImageAgeRating = { status: 'unassessed' } | { status: 'assessed'; labels: readonly ('r15' | 'r18' | 'r18g')[] };
export interface MediaImageReference { representationId: string; mediaUseId?: string }
export type ImageMetadataResolver = (references: MediaImageReference[]) => Promise<MediaImageMetadata[]>;
export interface MediaImageControl {
  locked: boolean;
  canEdit?: boolean;
  canProtect?: boolean;
  valueHead: string | null;
  basis: { head: string | null; epoch: string; protection: string | null };
}
export interface MediaImageMetadata extends MediaImageReference {
  /** Original lookup key for selection URLs; never part of authored document data. */
  requestKey?: string;
  src?: string;
  nsfw: 'unknown' | 'sfw' | 'nsfw';
  ageRating: ImageAgeRating;
  conceal?: boolean;
  revision?: string;
  controls?: { nsfw: MediaImageControl; ageRating: MediaImageControl; conceal?: MediaImageControl };
}
export const mediaImageLabels = {
  loading: 'Loading content preferences…', unavailable: 'Content unavailable',
  ratingHidden: 'This content is hidden by your age rating preferences.',
  masked: 'Masked image', nsfw: 'NSFW image', unknown: 'Image not assessed for NSFW', reveal: 'Show image',
  conceal: 'Mask this image', nsfwLabel: 'NSFW label', sfw: 'Not NSFW', unassessed: 'Not assessed',
  ageRating: 'Age rating', general: 'General', lock: 'Lock', unlock: 'Unlock', locked: 'Locked by a platform administrator',
  saveFailed: 'The image setting could not be saved. Try again.',
};
export type MediaImageLabels = { [K in keyof typeof mediaImageLabels]: string };
const anonymous: MediaImageViewer = { ready: true, signedIn: false, age: 'unknown', optIns: { general: true, r15: false, sexual: false, grotesque: false }, nsfwDisplay: 'mask' };
export { mediaImageKey };

interface ImageContext {
  viewer: MediaImageViewer;
  labels: MediaImageLabels;
  images: Readonly<Record<string, MediaImageMetadata | null>>;
  request: (reference: MediaImageReference) => void;
  update: (metadata: MediaImageMetadata) => void;
  refreshKey?: number | string;
  referenceFromUrl?: (src: string) => MediaImageReference | undefined;
  requestEpoch: number;
}
const noop = () => {};
const ImageContext = createContext<ImageContext>({ viewer: anonymous, labels: mediaImageLabels, images: {}, request: noop, update: noop, requestEpoch: 0 });

export function useMediaImageLabels() { return useContext(ImageContext).labels; }

/** Batches only the actual image references mounted by a consumer; never follows content references. */
export function MediaImageProvider({ viewer, images: supplied = {}, resolve, labels, children, refreshKey, referenceFromUrl }: {
  viewer: MediaImageViewer;
  images?: Readonly<Record<string, MediaImageMetadata | null>>;
  resolve?: ImageMetadataResolver;
  labels?: Partial<MediaImageLabels>;
  children: ReactNode;
  refreshKey?: number | string;
  referenceFromUrl?: (src: string) => MediaImageReference | undefined;
}) {
  const [loaded, setLoaded] = useState<Record<string, MediaImageMetadata | null>>({});
  const [requestEpoch, setRequestEpoch] = useState(0);
  const pending = useRef(new Map<string, MediaImageReference>());
  const scheduled = useRef(false);
  const requested = useRef(new Set<string>());
  const live = useRef(true);
  const generation = useRef(0);
  const priorRefresh = useRef(refreshKey);
  const resolver = useRef(resolve);
  resolver.current = resolve;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    if (priorRefresh.current === refreshKey) return;
    priorRefresh.current = refreshKey;
    generation.current++;
    setRequestEpoch(generation.current);
    requested.current.clear(); pending.current.clear(); setLoaded({});
  }, [refreshKey]);
  const request = useCallback((reference: MediaImageReference) => {
    const key = mediaImageKey(reference);
    if (!resolver.current || requested.current.has(key)) return;
    requested.current.add(key);
    pending.current.set(key, reference);
    if (scheduled.current) return;
    scheduled.current = true;
    queueMicrotask(() => {
      scheduled.current = false;
      const refs = [...pending.current.values()];
      const version = generation.current;
      pending.current.clear();
      for (let offset = 0; offset < refs.length; offset += 64) {
        const batch = refs.slice(offset, offset + 64);
        const read = resolver.current;
        if (!read) return;
        void read(batch).then(items => {
          if (!live.current || generation.current !== version) return;
          const result: Record<string, MediaImageMetadata | null> = Object.fromEntries(batch.map(ref => [mediaImageKey(ref), null]));
          for (const item of items) result[item.requestKey ?? mediaImageKey(item)] = item;
          setLoaded(prior => ({ ...prior, ...result }));
        }).catch(() => {
          if (live.current && generation.current === version) setLoaded(prior => ({ ...prior, ...Object.fromEntries(batch.map(ref => [mediaImageKey(ref), null])) }));
        });
      }
    });
  }, []);
  const update = useCallback((metadata: MediaImageMetadata) => {
    if (generation.current !== requestEpoch) return;
    setLoaded(prior => {
    const next = { ...prior };
    for (const [key, value] of Object.entries(prior)) {
      if (!value || value.representationId !== metadata.representationId) continue;
      next[key] = value.mediaUseId === metadata.mediaUseId ? { ...metadata, requestKey: value.requestKey }
        : { ...value, nsfw: metadata.nsfw, ageRating: metadata.ageRating, revision: metadata.revision,
          controls: value.controls && metadata.controls ? { ...value.controls, nsfw: metadata.controls.nsfw, ageRating: metadata.controls.ageRating } : value.controls };
    }
    next[metadata.requestKey ?? mediaImageKey(metadata)] = metadata;
    next[mediaImageKey(metadata)] = metadata;
    return next;
    });
  }, [requestEpoch]);
  const context = useMemo(() => ({ viewer, labels: { ...mediaImageLabels, ...labels }, images: { ...loaded, ...supplied }, request, update, refreshKey, referenceFromUrl, requestEpoch }), [viewer, labels, supplied, loaded, request, update, refreshKey, referenceFromUrl, requestEpoch]);
  return <ImageContext.Provider value={context}>{children}</ImageContext.Provider>;
}

/** Writer capabilities belong to this editing identity, independent from the surrounding reading session. */
export function ImageAuthoringScope({ resolve, scope, children }: { resolve: ImageMetadataResolver; scope?: string; children: ReactNode }) {
  const parent = useContext(ImageContext);
  return <MediaImageProvider viewer={parent.viewer} labels={parent.labels} resolve={resolve}
    refreshKey={`${parent.refreshKey ?? ''}:${scope ?? ''}`} referenceFromUrl={parent.referenceFromUrl}>{children}</MediaImageProvider>;
}

/** Metadata a server already resolved for the images below, so its HTML holds each image (or its mask)
 * instead of waiting for the client batch; the surrounding provider keeps the viewer, refresh and every other image. */
export function ResolvedMediaImages({ images, children }: { images: Readonly<Record<string, MediaImageMetadata | null>>; children: ReactNode }) {
  const parent = useContext(ImageContext);
  const context = useMemo(() => ({ ...parent, images: { ...parent.images, ...images } }), [parent, images]);
  return <ImageContext.Provider value={context}>{children}</ImageContext.Provider>;
}

export function useMediaImageMetadata(reference?: MediaImageReference) {
  const context = useContext(ImageContext);
  const representationId = reference?.representationId;
  const mediaUseId = reference?.mediaUseId;
  const key = representationId ? mediaImageKey({ representationId, mediaUseId }) : undefined;
  const metadata = key ? context.images[key] : undefined;
  useEffect(() => {
    if (representationId && metadata === undefined) context.request({ representationId, mediaUseId });
  }, [representationId, mediaUseId, metadata, context.request, context.refreshKey, context.requestEpoch]);
  return { metadata, updateMetadata: context.update };
}

/** Age labels, explicit concealment and NSFW preferences are independent display decisions. */
export function imagePresentation(metadata: Pick<MediaImageMetadata, 'nsfw' | 'ageRating'>, viewer: MediaImageViewer, conceal = false): 'loading' | 'rating-hidden' | 'masked' | 'visible' {
  if (!viewer.ready) return 'loading';
  if (metadata.ageRating.status === 'assessed') {
    const labels = metadata.ageRating.labels;
    if (!labels.length && !viewer.optIns.general) return 'rating-hidden';
    if (labels.length && (!viewer.signedIn || viewer.age === 'unknown' || viewer.age === 'under-15')) return 'rating-hidden';
    if (labels.includes('r15') && !viewer.optIns.r15) return 'rating-hidden';
    if ((labels.includes('r18') || labels.includes('r18g')) && viewer.age !== 'adult') return 'rating-hidden';
    if (labels.includes('r18') && !viewer.optIns.sexual || labels.includes('r18g') && !viewer.optIns.grotesque) return 'rating-hidden';
  }
  if (conceal || metadata.nsfw === 'unknown' || metadata.nsfw === 'nsfw' && viewer.nsfwDisplay !== 'show') return 'masked';
  return 'visible';
}

export interface MediaImageProps extends ComponentProps<'img'> {
  metadata?: MediaImageMetadata;
  representationId?: string;
  mediaUseId?: string;
  conceal?: boolean;
  viewer?: MediaImageViewer;
  labels?: Partial<MediaImageLabels>;
  revealable?: boolean;
  compact?: boolean;
}
type ImageDecisionInput = Pick<MediaImageProps, 'metadata' | 'representationId' | 'mediaUseId' | 'conceal' | 'viewer' | 'src'>;
function useImageDecision({ metadata: supplied, representationId, mediaUseId, conceal = false, viewer: suppliedViewer, src }: ImageDecisionInput) {
  const context = useContext(ImageContext);
  const reference = representationId ? { representationId, mediaUseId } : typeof src === 'string' ? context.referenceFromUrl?.(src) : undefined;
  const { metadata: resolved } = useMediaImageMetadata(supplied ? undefined : reference);
  const metadata = supplied ?? resolved;
  const viewer = suppliedViewer ?? context.viewer;
  const managed = Boolean(reference || supplied);
  const effectiveConceal = metadata?.mediaUseId ? Boolean(metadata.conceal) : conceal || Boolean(metadata?.conceal);
  const presentation = managed && metadata === undefined ? 'loading' : managed && metadata === null ? 'unavailable'
    : imagePresentation(metadata ?? { nsfw: 'sfw', ageRating: { status: 'unassessed' } }, viewer, effectiveConceal);
  return { context, metadata, viewer, effectiveConceal, presentation };
}

/** What a MediaImage with this `src` shows here and the URL it loads, so a consumer can leave out what it
 * would not show (a picture source, a preload). Requests metadata the same way. */
export function useMediaImagePresentation(src: string | undefined) {
  const { metadata, presentation } = useImageDecision({ src });
  return { presentation, src: metadata?.src ?? src };
}

/** A mask never mounts the original image; revealing is local and resets with labels or preference changes. */
export function MediaImage({ metadata: supplied, representationId, mediaUseId, conceal = false, viewer: suppliedViewer, labels: overrides, revealable = true, compact = false, className, src: fallbackSrc, alt = '', ...props }: MediaImageProps) {
  const { context, metadata, viewer, effectiveConceal, presentation } = useImageDecision({ metadata: supplied,
    representationId, mediaUseId, conceal, viewer: suppliedViewer, src: fallbackSrc });
  const labels = { ...context.labels, ...overrides };
  const identity = `${mediaImageKey(metadata ?? { representationId: representationId ?? String(fallbackSrc ?? ''), mediaUseId })}:${metadata?.revision ?? ''}:${metadata?.nsfw ?? ''}:${metadata?.ageRating.status}:${metadata?.ageRating.status === 'assessed' ? metadata.ageRating.labels.join(',') : ''}:${effectiveConceal}:${presentation}:${viewer.nsfwDisplay}`;
  const [reveal, setReveal] = useState({ identity, open: false });
  if (reveal.identity !== identity) setReveal({ identity, open: false });
  const src = safeDocumentUrl(metadata?.src ?? fallbackSrc, true);
  if (presentation === 'loading' || presentation === 'unavailable' || presentation === 'rating-hidden' || !src) {
    const label = presentation === 'loading' ? labels.loading : presentation === 'rating-hidden' ? labels.ratingHidden : labels.unavailable;
    if (!revealable || compact) return <span data-slot="media-image-placeholder" role="img" aria-label={label} title={label} style={props.style}
      className={cn('flex items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground', className)}><EyeOffIcon aria-hidden="true" className="size-4 shrink-0" /></span>;
    return <span data-slot="media-image-placeholder" role="status" className={cn('flex min-h-24 items-center justify-center rounded-lg bg-muted px-4 py-6 text-center font-sans text-sm text-muted-foreground', className)}>{label}</span>;
  }
  if (presentation === 'masked' && (reveal.identity !== identity || !reveal.open)) {
    const reason = effectiveConceal ? labels.masked : metadata?.nsfw === 'nsfw' ? labels.nsfw : labels.unknown;
    if (!revealable) return <span data-slot="media-image-mask" role="img" aria-label={reason} title={reason} style={props.style}
      className={cn('flex items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground', className)}><EyeOffIcon aria-hidden="true" className="size-4 shrink-0" /></span>;
    if (compact) return <Button type="button" data-slot="media-image-mask" variant="secondary"
      aria-label={`${reason}. ${labels.reveal}`} title={labels.reveal} aria-expanded="false"
      style={props.style} className={cn('size-full rounded-[inherit]', className)}
      onClick={() => setReveal({ identity, open: true })}><EyeOffIcon aria-hidden="true" className="size-4" /></Button>;
    return <span data-slot="media-image-mask" className={cn('flex min-h-32 flex-col items-center justify-center gap-3 rounded-lg bg-muted px-4 py-6 text-center font-sans text-sm text-muted-foreground', className)}>
      <span>{reason}</span>{revealable ? <Button type="button" variant="secondary" size="sm" onClick={() => setReveal({ identity, open: true })} aria-expanded="false">{labels.reveal}</Button> : null}
    </span>;
  }
  return <img {...props} data-slot="media-image" src={src} alt={alt} className={className} loading={props.loading ?? 'lazy'} referrerPolicy="no-referrer" />;
}
