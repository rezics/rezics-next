// Framing showcase backgrounds on the oriented source, in whole pixels, exactly as Main admits them
// (docs/contracts/media.md#showcase-art). The browser keeps the original; Main stores the frame as
// the Use's `xywh=percent:` fragment and renders every width from it, so the editor never sends
// cropped bytes. Main refuses any other frame with a typed problem; framing to its rule up front
// means a person never meets that refusal for something the editor could have prevented.

export interface Size { width: number; height: number }
/** A rectangle of oriented source pixels. */
export interface PixelRect { left: number; top: number; width: number; height: number }

export type BackgroundRole = 'background-landscape' | 'background-portrait';

/** Each background's exact ratio (in whole units) and the smallest frame Main accepts. */
export const backgroundFrames = {
  'background-landscape': { units: [16, 9], min: { width: 1280, height: 720 } },
  'background-portrait': { units: [3, 4], min: { width: 960, height: 1280 } },
} as const satisfies Record<BackgroundRole, { units: readonly [number, number]; min: Size }>;

/** A frame of an exact ratio is `units × scale` pixels; the scale is the one thing its size can vary. */
function scales(role: BackgroundRole, size: Size) {
  const { units: [w, h], min } = backgroundFrames[role];
  return { w, h, least: Math.max(Math.ceil(min.width / w), Math.ceil(min.height / h)),
    most: Math.min(Math.floor(size.width / w), Math.floor(size.height / h)) };
}

/** Whether an image is large enough to hold the smallest admitted frame of its role. */
export const holdsFrame = (role: BackgroundRole, size: Size) => {
  const { least, most } = scales(role, size);
  return most >= least;
};

/** The largest exact frame centred in the image, or null when the image is too small for the role. */
export function initialFrame(role: BackgroundRole, size: Size): PixelRect | null {
  const { w, h, least, most } = scales(role, size);
  if (most < least) return null;
  const width = w * most;
  const height = h * most;
  return { left: Math.floor((size.width - width) / 2), top: Math.floor((size.height - height) / 2), width, height };
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * The exact frame nearest to a free rectangle: the nearest admitted scale, kept inside the image.
 * `fixed` names the corner that stays put while the opposite corner handle resizes; a move or a
 * size change without one keeps the centre.
 */
export function snapFrame(role: BackgroundRole, size: Size, rect: PixelRect,
  fixed?: 'nw' | 'ne' | 'sw' | 'se'): PixelRect {
  const { w, h, least, most } = scales(role, size);
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  const west = fixed === 'nw' || fixed === 'sw';
  const north = fixed === 'nw' || fixed === 'ne';
  // From a fixed corner the frame may only grow into the room on its side of the image.
  const room = fixed ? Math.min(Math.floor((west ? size.width - rect.left : right) / w),
    Math.floor((north ? size.height - rect.top : bottom) / h)) : most;
  const scale = clamp(Math.round(Math.max(rect.width / w, rect.height / h)), least, Math.max(least, Math.min(most, room)));
  const width = w * scale;
  const height = h * scale;
  const left = !fixed ? rect.left + (rect.width - width) / 2 : west ? rect.left : right - width;
  const top = !fixed ? rect.top + (rect.height - height) / 2 : north ? rect.top : bottom - height;
  return { left: clamp(Math.round(left), 0, size.width - width), top: clamp(Math.round(top), 0, size.height - height), width, height };
}

/** The frame at another admitted scale, about the same centre: what a size slider sets. */
export function resizeFrame(role: BackgroundRole, size: Size, frame: PixelRect, scale: number): PixelRect {
  const { w, h } = scales(role, size);
  return snapFrame(role, size, { left: frame.left + (frame.width - w * scale) / 2, top: frame.top + (frame.height - h * scale) / 2,
    width: w * scale, height: h * scale });
}

/** The admitted scales of a role in an image and the scale of a frame, for a size slider. */
export function frameScale(role: BackgroundRole, size: Size, frame: PixelRect) {
  const { w, least, most } = scales(role, size);
  return { least, most, value: Math.round(frame.width / w) };
}

/** A rectangle moved by whole pixels and kept inside `bounds`. */
export function moveRect(rect: PixelRect, dx: number, dy: number, bounds: PixelRect): PixelRect {
  return { ...rect, left: clamp(Math.round(rect.left + dx), bounds.left, bounds.left + bounds.width - rect.width),
    top: clamp(Math.round(rect.top + dy), bounds.top, bounds.top + bounds.height - rect.height) };
}

/** A focal area kept within its frame: shifted inside, and shrunk only when it is larger than the frame. */
export function containRect(rect: PixelRect, bounds: PixelRect): PixelRect {
  const width = Math.min(Math.max(1, Math.round(rect.width)), bounds.width);
  const height = Math.min(Math.max(1, Math.round(rect.height)), bounds.height);
  return { width, height, left: clamp(Math.round(rect.left), bounds.left, bounds.left + bounds.width - width),
    top: clamp(Math.round(rect.top), bounds.top, bounds.top + bounds.height - height) };
}

/** A starting focal area: the middle of the frame, a third of each side. */
export const initialFocal = (frame: PixelRect): PixelRect => containRect({ left: frame.left + frame.width / 3,
  top: frame.top + frame.height / 3, width: frame.width / 3, height: frame.height / 3 }, frame);

// Main reads a percent fragment in thousandths of a percent and rounds to pixels as `pixelArea`
// does (services/main/src/modules/media-rendition/policy.ts `pixelCrop`): the left/top edge
// floors and the extent ceils. `percentArea` picks the values that land on the exact pixels.
const UNIT = 100_000;
const fixed = (thousandths: number) => String(thousandths / 1000);

/** The `xywh=percent:` fragment whose pixels, as Main rounds them, are exactly `rect`. */
export function percentArea(rect: PixelRect, size: Size): string {
  const x = Math.ceil((rect.left * UNIT) / size.width);
  const y = Math.ceil((rect.top * UNIT) / size.height);
  const w = Math.min(Math.floor((rect.width * UNIT) / size.width), UNIT - x);
  const h = Math.min(Math.floor((rect.height * UNIT) / size.height), UNIT - y);
  return `xywh=percent:${fixed(x)},${fixed(y)},${fixed(w)},${fixed(h)}`;
}

/** The pixels a fragment names on an image, rounded as Main rounds them; null for a malformed fragment. */
export function pixelArea(area: string | null, size: Size): PixelRect | null {
  if (area === null) return { left: 0, top: 0, ...size };
  if (!/^xywh=percent:([0-9]{1,3}(\.[0-9]{1,3})?,){3}[0-9]{1,3}(\.[0-9]{1,3})?$/.test(area)) return null;
  const [x, y, w, h] = area.slice('xywh=percent:'.length).split(',').map(value => Math.round(Number(value) * 1000)) as
    [number, number, number, number];
  if (w <= 0 || h <= 0 || x + w > UNIT || y + h > UNIT) return null;
  const left = Math.floor((x * size.width) / UNIT);
  const top = Math.floor((y * size.height) / UNIT);
  return { left, top, width: Math.min(size.width - left, Math.ceil((w * size.width) / UNIT)),
    height: Math.min(size.height - top, Math.ceil((h * size.height) / UNIT)) };
}

/** A focal area as fractions of its frame, the form the showcase stage reads (`ZoneFocalArea`). */
export const focalWithin = (focal: PixelRect, frame: PixelRect) => ({ x: (focal.left - frame.left) / frame.width,
  y: (focal.top - frame.top) / frame.height, width: focal.width / frame.width, height: focal.height / frame.height });

/** The share of a 16:9 frame's width that a 3:4 phone card shows when it cuts the landscape art. */
export const PHONE_WINDOW = (3 / 4) / (16 / 9);

/**
 * What a phone shows of landscape art when the Work has no portrait art, as the stage decides it
 * (`focalFrame` in features/showcase/stage.ts): a 3:4 cut centred on the focal area when the area
 * fits in one, otherwise the whole image on a backdrop made from itself. `window` is in frame pixels.
 */
export function phoneView(frame: PixelRect, focal: PixelRect | null):
  { kind: 'whole'; reason: 'no-focal' | 'focal-too-wide' } | { kind: 'cut'; window: PixelRect } {
  if (!focal) return { kind: 'whole', reason: 'no-focal' };
  const width = frame.width * PHONE_WINDOW;
  if (focal.width > width) return { kind: 'whole', reason: 'focal-too-wide' };
  const centre = focal.left + focal.width / 2;
  const left = clamp(centre - width / 2, frame.left, frame.left + frame.width - width);
  return { kind: 'cut', window: { left, top: frame.top, width, height: frame.height } };
}
