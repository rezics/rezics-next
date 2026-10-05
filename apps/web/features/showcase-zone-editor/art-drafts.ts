import { useCallback, useEffect, useRef, useState } from 'react';
import type { CampaignArtInput, CampaignArtResult } from './actions.ts';
import type { Registry } from './art.ts';
import {
  type Draft, type Drafts, type Framed, type ImageDraft, type LogoAnchor, logoKey, type SavedImage, type SlotKey,
} from '../showcase-editor/art.ts';
import { decodedSize, drawFrame } from '../showcase-editor/draw.ts';
import { backgroundFrames, type BackgroundRole, initialFrame, percentArea, type PixelRect } from '../showcase-editor/frame.ts';
import { declaresAlpha, fileProblem, pixelProblem } from '../showcase-editor/image-file.ts';
import type { SlotStatus } from '../showcase-editor/status.tsx';
import type { uploadShowcaseImage } from '../showcase-editor/upload.ts';
import type { SlideArt } from './slides.ts';

// The unsaved images of a showcase's slides. A person chooses a file, frames it where it is a
// background and adds it to the slide: only then is it uploaded (and screened) and made the Realm's
// campaign art, so a slow or refused image is reported where it was chosen. Adding it changes the
// slide's art in the editor; nothing reaches readers until the showcase is saved.

type StatusKey = `${string}\u0000${SlotKey}`;
const statusKey = (slide: string, slot: SlotKey): StatusKey => `${slide}\u0000${slot}`;
const backgrounds: readonly BackgroundRole[] = ['background-landscape', 'background-portrait'];
export const isBackground = (slot: SlotKey): slot is BackgroundRole => slot === 'background-landscape' || slot === 'background-portrait';
const frameKey = (url: string, frame: PixelRect) => `${url}#${frame.left},${frame.top},${frame.width},${frame.height}`;

export interface ArtDraftsInput {
  zone: string;
  /** The Realm campaign art belongs to; without one nothing can be added. */
  realm: string | null;
  actingSubject: string;
  registry: Registry;
  setRegistry: (update: (registry: Registry) => Registry) => void;
  /** Changes one slide's art references (the document the editor will save). */
  setArt: (slide: string, update: (art: SlideArt) => SlideArt) => void;
  addArt: (input: CampaignArtInput) => Promise<CampaignArtResult>;
  upload: typeof uploadShowcaseImage;
}

export function useArtDrafts({ zone, realm, actingSubject, registry, setRegistry, setArt, addArt, upload }: ArtDraftsInput) {
  const [drafts, setDrafts] = useState<Record<string, Drafts>>({});
  const [statuses, setStatuses] = useState<Partial<Record<StatusKey, SlotStatus>>>({});
  const [framed, setFramed] = useState<Framed>({});
  const latest = useRef(drafts);
  latest.current = drafts;
  /** Object URLs this editor made; they live as long as the page that shows them. */
  const urls = useRef(new Set<string>());
  useEffect(() => () => { for (const url of urls.current) URL.revokeObjectURL(url); }, []);

  const setStatus = (slide: string, slot: SlotKey, status?: SlotStatus) => setStatuses(all => ({ ...all, [statusKey(slide, slot)]: status }));
  const putDraft = useCallback((slide: string, slot: SlotKey, draft: Draft | undefined) => {
    const slideDrafts = { ...latest.current[slide] };
    if (draft) slideDrafts[slot] = draft; else delete slideDrafts[slot];
    latest.current = { ...latest.current, [slide]: slideDrafts };
    if (!Object.keys(slideDrafts).length) delete latest.current[slide];
    setDrafts(latest.current);
  }, []);
  const drop = (draft: Draft | undefined) => {
    if (draft?.kind !== 'image') return;
    if (draft.source.file) { URL.revokeObjectURL(draft.source.url); urls.current.delete(draft.source.url); }
    if (draft.framed) { URL.revokeObjectURL(draft.framed.url); urls.current.delete(draft.framed.url); }
  };

  // The stage cannot crop, so each framed background draft is drawn at preview size once its frame settles.
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const [slide, slots] of Object.entries(drafts)) {
        for (const slot of backgrounds) {
          const draft = slots[slot];
          if (draft?.kind !== 'image' || !draft.frame) continue;
          const key = frameKey(draft.source.url, draft.frame);
          if (draft.framed?.key === key) continue;
          void drawFrame(draft.source.url, draft.frame, draft.source.size).then(drawn => {
            const now = latest.current[slide]?.[slot];
            if (!drawn || now?.kind !== 'image' || !now.frame || frameKey(now.source.url, now.frame) !== key) {
              if (drawn) URL.revokeObjectURL(drawn.url);
              return;
            }
            if (now.framed) { URL.revokeObjectURL(now.framed.url); urls.current.delete(now.framed.url); }
            urls.current.add(drawn.url);
            putDraft(slide, slot, { ...now, framed: { ...drawn, key } });
          });
        }
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [drafts, putDraft]);

  // An image Main has no width renditions for yet is drawn from its original and frame.
  useEffect(() => {
    for (const image of Object.values(registry)) {
      if (!isBackground(image.slot) || image.candidates.length || framed[image.selection]) continue;
      void drawFrame(image.url, image.frame, image.size).then(drawn => {
        if (!drawn) return;
        urls.current.add(drawn.url);
        setFramed(all => ({ ...all, [image.selection]: drawn }));
      });
    }
  }, [registry, framed]);

  async function choose(slide: string, slot: SlotKey, file: File, anchor?: LogoAnchor) {
    const background = isBackground(slot);
    const problem = fileProblem(file, background ? 'background' : 'layer');
    if (problem) return setStatus(slide, slot, { kind: 'file', problem });
    if (!background && !declaresAlpha(new Uint8Array(await file.arrayBuffer()))) return setStatus(slide, slot, { kind: 'file', problem: 'alpha' });
    const url = URL.createObjectURL(file);
    const size = await decodedSize(url);
    const sizeProblem = size ? pixelProblem(size) : 'unreadable';
    const frame = background && size ? initialFrame(slot, size) : null;
    if (!size || sizeProblem || (background && !frame)) {
      URL.revokeObjectURL(url);
      return setStatus(slide, slot, sizeProblem || !size ? { kind: 'file', problem: sizeProblem ?? 'unreadable' }
        : { kind: 'file', problem: 'small', size, min: backgroundFrames[slot as BackgroundRole].min });
    }
    const previous = latest.current[slide]?.[slot];
    drop(previous);
    urls.current.add(url);
    putDraft(slide, slot, { kind: 'image', base: null, source: { url, size, file, asset: null }, frame, focal: null, framed: null,
      uploadKey: `showcase:${crypto.randomUUID()}`,
      anchor: logoKey(slot) ? anchor ?? (previous?.kind === 'image' ? previous.anchor : null) ?? 'start-bottom' : null });
    setStatus(slide, slot, undefined);
  }

  /** Changes the frame, focal area or anchor of an image that is not added yet. */
  function adjust(slide: string, slot: SlotKey, change: Partial<Pick<ImageDraft, 'frame' | 'focal' | 'anchor'>>) {
    const current = latest.current[slide]?.[slot];
    if (current?.kind === 'image') putDraft(slide, slot, { ...current, ...change });
    setStatus(slide, slot, undefined);
  }

  function discard(slide: string, slot: SlotKey) {
    drop(latest.current[slide]?.[slot]);
    putDraft(slide, slot, undefined);
    setStatus(slide, slot, undefined);
  }

  /** Takes an added image off the slide: the Work's art, or the cover, serves again once the showcase is saved. */
  function remove(slide: string, slot: SlotKey) {
    discard(slide, slot);
    setArt(slide, art => { const next = { ...art }; delete next[slot]; return next; });
  }

  /** Forgets every draft of a slide that is going away. */
  function forget(slide: string) {
    for (const draft of Object.values(latest.current[slide] ?? {})) drop(draft);
    if (latest.current[slide]) {
      latest.current = { ...latest.current };
      delete latest.current[slide];
      setDrafts(latest.current);
    }
  }

  /** Lets go of every unsaved image, as when a person discards the showcase's changes. */
  function reset() {
    for (const slots of Object.values(latest.current)) for (const draft of Object.values(slots)) drop(draft);
    latest.current = {};
    setDrafts(latest.current);
    setStatuses({});
  }

  /** Uploads the chosen image, makes it the Realm's campaign art for the slide's role and gives the slide that Use. */
  async function add(slide: string, slot: SlotKey) {
    const started = latest.current[slide]?.[slot];
    if (started?.kind !== 'image' || !realm) return;
    // The draft object changes while adding (a redrawn preview); the chosen file names the change.
    const same = (draft: Draft | undefined) => draft?.kind === 'image' && draft.source.url === started.source.url;
    setStatus(slide, slot, { kind: 'busy', stage: 'saving' });
    let asset = started.source.asset;
    if (!asset && started.source.file) {
      const uploaded = await upload({ file: started.source.file, actingSubject, key: started.uploadKey ?? `showcase:${crypto.randomUUID()}`,
        onStage: stage => setStatus(slide, slot, { kind: 'busy', stage }), cancelled: () => !same(latest.current[slide]?.[slot]) });
      const now = latest.current[slide]?.[slot];
      if (!same(now) || now?.kind !== 'image') return;
      if (uploaded.status === 'refused') return setStatus(slide, slot, { kind: 'upload', reason: uploaded.reason,
        ...uploaded.retryAfter ? { retryAfter: uploaded.retryAfter } : {} });
      asset = uploaded.asset;
      putDraft(slide, slot, { ...now, source: { ...now.source, asset } });
      setStatus(slide, slot, { kind: 'busy', stage: 'saving' });
    }
    const draft = latest.current[slide]?.[slot];
    if (draft?.kind !== 'image' || !asset) return;
    const key = logoKey(slot);
    const result = await addArt({ zone, realm, role: key ? 'logo' : slot as Exclude<CampaignArtInput['role'], 'logo'>,
      ...key ? { language: key.language, tone: key.tone, anchor: draft.anchor ?? 'start-bottom' } : {},
      asset, crop: draft.frame ? percentArea(draft.frame, draft.source.size) : null,
      focalArea: draft.frame && draft.focal ? percentArea(draft.focal, draft.source.size) : null });
    // The person chose another file while this one was being added: that change owns the slot now.
    if (!same(latest.current[slide]?.[slot])) return;
    if (result.status === 'refused') return setStatus(slide, slot, { kind: 'refused', refusal: result.refusal, detail: result.detail, current: null });
    const frame = draft.frame ?? { left: 0, top: 0, ...draft.source.size };
    const image: SavedImage = { slot, selection: result.use, asset, url: draft.source.url, size: draft.source.size, frame,
      focal: draft.focal, anchor: draft.anchor, candidates: [] };
    // The image stays as the chosen file; Main's width renditions replace it once the page reads them.
    if (draft.framed) setFramed(all => ({ ...all, [result.use]: { url: draft.framed!.url, size: draft.framed!.size } }));
    setRegistry(all => ({ ...all, [result.use]: image }));
    setArt(slide, art => ({ ...art, [slot]: { use: result.use, ...key ? { anchor: draft.anchor ?? 'start-bottom' } : {} } }));
    // The source URL now belongs to the registry; the draft only lets go of its own copies.
    latest.current = { ...latest.current, [slide]: { ...latest.current[slide] } };
    delete latest.current[slide]![slot];
    if (!Object.keys(latest.current[slide]!).length) delete latest.current[slide];
    setDrafts(latest.current);
    setStatus(slide, slot, { kind: 'saved', replayed: result.replayed });
  }

  const pending = Object.values(drafts).reduce((count, slots) => count + Object.keys(slots).length, 0);
  const busy = Object.values(statuses).some(status => status?.kind === 'busy');
  return { drafts, statuses, framed, pending, busy, choose, adjust, discard, remove, forget, reset, add,
    status: (slide: string, slot: SlotKey) => statuses[statusKey(slide, slot)] };
}

export type ArtDrafts = ReturnType<typeof useArtDrafts>;
