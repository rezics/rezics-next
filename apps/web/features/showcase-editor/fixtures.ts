import { direction } from '@rezics/main/language';
import type { ZoneText, ZoneWork } from '@rezics/zone-sdk';
import { resourceHref } from '../address/path.ts';
import type { ShowcaseImage, WorkShowcase } from '../api/showcase.ts';
import cutoutUrl from '../showcase/art/cutout.svg?url&no-inline';
import landscapeUrl from '../showcase/art/landscape.svg?url&no-inline';
import englishLight from '../showcase/art/logo-en-light.svg?url&no-inline';
import japaneseLight from '../showcase/art/logo-ja-light.svg?url&no-inline';
import portraitUrl from '../showcase/art/portrait.svg?url&no-inline';
import type { ArtSelection } from './actions.ts';
import type { SaveResult } from './refusal.ts';
import type { Uploaded, UploadStage } from './upload.ts';

// A Work and its showcase art as Main's batch read returns them, for stories and tests. The art is
// the showcase feature's own fixture SVGs, described at the sizes a real upload would have.

const text = (value: string, lang: string): ZoneText => ({ value, lang, dir: direction(lang, value) });
export const workId = '01a0e3d1-0000-7000-8000-000000000001';
export const workIri = `https://rezics.com/id/${workId}`;
export const work: { id: string; card: ZoneWork; title: ZoneText; tagline: ZoneText | null } = {
  id: workId,
  title: text('Astral Tide', 'en'),
  tagline: text('A lighthouse between worlds. A letter that never reached home.', 'en'),
  card: { id: workIri, href: resourceHref('/w/', workId), title: text('Astral Tide', 'en'), cover: null, kind: 'book', author: null,
    tagline: text('A lighthouse between worlds. A letter that never reached home.', 'en'), status: null, chapters: null,
    words: null, updatedAt: null, decision: '#why-here' },
};
export const titles: Record<string, { title: ZoneText; tagline: ZoneText | null }> = {
  'zh-Hant': { title: text('星潮', 'zh-Hant'), tagline: text('世界交界的燈塔，與一封從未抵達故鄉的信。', 'zh-Hant') },
  ja: { title: text('星の潮', 'ja'), tagline: text('世界の境に立つ灯台。故郷に届かなかった一通の手紙。', 'ja') },
  ar: { title: text('مدّ النجوم', 'ar'), tagline: text('منارة بين عالمين، ورسالة لم تصل إلى الوطن.', 'ar') },
};

let serial = 0;
const id = () => `01a0e3d1-0000-7000-8000-${String(++serial).padStart(12, '0')}`;
function image(role: ShowcaseImage['role'], url: string, width: number, height: number,
  extra: Partial<ShowcaseImage> = {}): ShowcaseImage {
  return { role, selection: id(), asset: id(), use: id(), representation: id(), context: 'urn:rezics:media:context:default',
    url, mediaType: 'image/png', width, height, cropWidth: width, cropHeight: height, crop: 'xywh=percent:0,0,100,100',
    focalArea: null, srcset: [{ url, type: 'image/webp', width, height }], ...extra };
}

export type FixtureArt = 'empty' | 'partial' | 'complete';

/** The Work's art: none, a landscape background with its focal area only, or every role, two logos and a trailer. */
export function savedFixture(kind: FixtureArt): WorkShowcase | null {
  if (kind === 'empty') return { reference: workIri, status: 'available', images: [], trailer: null };
  const landscape = image('background-landscape', landscapeUrl, 1920, 1080, { focalArea: 'xywh=percent:60,22,20,46' });
  if (kind === 'partial') return { reference: workIri, status: 'available', images: [landscape], trailer: null };
  return { reference: workIri, status: 'available', trailer: { selection: id(), context: 'urn:rezics:media:context:default',
    url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', provider: 'youtube' },
  images: [landscape, image('background-portrait', portraitUrl, 1500, 2000, { focalArea: 'xywh=percent:52,24,26,40' }),
    image('cutout', cutoutUrl, 420, 700), image('logo', englishLight, 600, 200, { language: 'en', tone: 'light', anchor: 'start-bottom' }),
    image('logo', japaneseLight, 600, 200, { language: 'ja', tone: 'light', anchor: 'center-top' })] };
}

/** A 1×1 RGB PNG: a valid image with no alpha channel. */
export const opaquePng = () => new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'),
  character => character.charCodeAt(0))], 'logo.png', { type: 'image/png' });

/** A real image file drawn in the browser, as a person would choose one. */
export async function drawnFile(width: number, height: number, type: 'image/jpeg' | 'image/png', name: string): Promise<File> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d')!;
  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#0a1d38');
  sky.addColorStop(0.6, '#2f6290');
  sky.addColorStop(1, '#f2a979');
  context.fillStyle = sky;
  if (type === 'image/jpeg') context.fillRect(0, 0, width, height);
  context.fillStyle = '#fff1c4';
  context.beginPath();
  context.arc(width * 0.7, height * 0.35, Math.min(width, height) * 0.12, 0, Math.PI * 2);
  context.fill();
  return new File([await canvas.convertToBlob({ type })], name, { type });
}

/** Story and test stand-ins for Main and the upload protocol. */
export const answers = {
  done: async (): Promise<SaveResult> => ({ status: 'done', selection: id(), replayed: false }),
  refused: (refusal: Extract<SaveResult, { status: 'refused' }>['refusal'], detail: string | null = null) =>
    async (): Promise<SaveResult> => ({ status: 'refused', refusal, code: null, detail, current: refusal === 'conflict' ? id() : null }),
};
/** Main's expected-selection rule for one Work: a save that does not start from the slot's current selection is a conflict. */
export function mainLike(saved: WorkShowcase | null) {
  const heads = new Map<string, string | null>((saved?.images ?? []).map(entry =>
    [entry.role === 'logo' ? `logo:${entry.language}:${entry.tone}` : entry.role, entry.selection]));
  return async (input: ArtSelection): Promise<SaveResult> => {
    const slot = input.role === 'logo' ? `logo:${input.language}:${input.tone}` : input.role;
    const head = heads.get(slot) ?? null;
    if (input.expectedSelection !== head) return { status: 'refused', refusal: 'conflict', code: 'stale_head', detail: null, current: head };
    const selection = id();
    heads.set(slot, selection);
    return { status: 'done', selection, replayed: false };
  };
}
export function uploads(outcome: Uploaded, stages: readonly UploadStage[] = ['uploading', 'screening']) {
  return async (input: { onStage: (stage: UploadStage) => void }): Promise<Uploaded> => {
    for (const stage of stages) {
      input.onStage(stage);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return outcome;
  };
}
export const loadTitle = async (_work: string, language: string) => titles[language] ?? null;
