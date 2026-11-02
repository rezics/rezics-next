import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';
import { selectSettingsCategory } from './settings-category-navigation';

type MediaRecord = {
  method: string;
  path: string;
  csrf: string | null;
  id?: string;
  body?: Record<string, unknown>;
  bytes?: Blob;
  source?: Blob;
  idempotencyKey?: string | null;
};

type HeldRead = {
  file: File;
  resolve: (buffer: ArrayBuffer) => void;
  reject: (error: unknown) => void;
};

const traffic: { media: MediaRecord[]; profileWrites: MediaRecord[]; reservationIds: string[] } = {
  media: [],
  profileWrites: [],
  reservationIds: [],
};
let decoderSources: ImageBitmapSource[] = [];
let fileUrls: { file: File; url: string; revocations: number }[] = [];
let headerReads = new WeakMap<File, number>();
let heldFile: File | undefined;
let heldRead: HeldRead | undefined;
let heldReadStarted: Promise<void> = Promise.resolve();
let announceHeldRead: (() => void) | undefined;
let nativeFetch: typeof fetch;
let nativeCreateImageBitmap: typeof createImageBitmap;
let nativeCreateObjectURL: typeof URL.createObjectURL;
let nativeRevokeObjectURL: typeof URL.revokeObjectURL;
let nativeArrayBuffer: typeof Blob.prototype.arrayBuffer;
let blobArrayBufferDescriptor: PropertyDescriptor | undefined;

const meta = {
  title: 'Pages/Settings/Avatar predecode',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function fileBytes(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function writeUint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function writeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const name = new Uint8Array([...type].map((character) => character.charCodeAt(0)));
  const crcInput = concatBytes(name, data);
  return concatBytes(writeUint32(data.byteLength), crcInput, writeUint32(writeCrc32(crcInput)));
}

function pngHeader(width: number, height: number, animated = false): File {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  header[8] = 8;
  header[9] = 6;
  const animation = animated ? pngChunk('acTL', concatBytes(writeUint32(2), writeUint32(0))) : new Uint8Array();
  const imageData = pngChunk('IDAT', new Uint8Array([0x78, 0x01, 0x00]));
  const content = concatBytes(
    signature,
    pngChunk('IHDR', header),
    animation,
    imageData,
    pngChunk('IEND', new Uint8Array()),
  );
  return new File([fileBytes(content)], animated ? 'animated.png' : 'header.png', {
    type: 'image/png',
    lastModified: 1,
  });
}

function jpegHeader(width: number, height: number): File {
  const app0 = new Uint8Array([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]);
  const frame = new Uint8Array(13);
  frame.set([0xff, 0xc0, 0x00, 0x0b, 0x08], 0);
  new DataView(frame.buffer).setUint16(5, height, false);
  new DataView(frame.buffer).setUint16(7, width, false);
  frame.set([0x01, 0x01, 0x11, 0x00], 9);
  const scan = new Uint8Array([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  return new File(
    [fileBytes(concatBytes(new Uint8Array([0xff, 0xd8]), app0, frame, scan, new Uint8Array([0xff, 0xd9])))],
    'header.jpg',
    {
      type: 'image/jpeg',
      lastModified: 1,
    },
  );
}

function malformedFiles(): File[] {
  return [
    new File([fileBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))], 'truncated-signature.png', { type: 'image/png' }),
    new File(
      [
        fileBytes(
          concatBytes(
            new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            writeUint32(0xffff_ffff),
            new Uint8Array([0x49, 0x48, 0x44, 0x52]),
          ),
        ),
      ],
      'invalid-length.png',
      { type: 'image/png' },
    ),
    new File([fileBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x01]))], 'short-length.jpg', {
      type: 'image/jpeg',
    }),
    new File([fileBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x01]))], 'truncated-segment.jpg', {
      type: 'image/jpeg',
    }),
    jpegHeader(8_192, 8_192),
    pngHeader(8_192, 8_192),
    pngHeader(32, 32, true),
    new File([fileBytes(new Uint8Array([0x47, 0x49, 0x46, 0x38]))], 'animated.gif', { type: 'image/gif' }),
    new File([fileBytes(new Uint8Array([0x52, 0x49, 0x46, 0x46]))], 'still.webp', { type: 'image/webp' }),
    new File([fileBytes(new Uint8Array([0x00, 0x00, 0x00, 0x20]))], 'still.avif', { type: 'image/avif' }),
  ];
}

async function canvasImage(
  width: number,
  height: number,
  type: 'image/jpeg' | 'image/png',
  name: string,
): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create the local image fixture');
  context.fillStyle = '#326c91';
  context.fillRect(0, 0, width, height);
  if (height > 1) {
    context.fillStyle = '#f4cf49';
    context.fillRect(
      Math.floor(width * 0.65),
      Math.floor(height * 0.65),
      Math.ceil(width * 0.25),
      Math.ceil(height * 0.25),
    );
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error('Could not encode the local image fixture'))),
      type,
    );
  });
  return new File([blob], name, { type, lastModified: 1 });
}

function isTrackedUrl(file: Blob | MediaSource): file is File {
  return typeof File !== 'undefined' && file instanceof File;
}

function holdNextRead(file: File) {
  heldFile = file;
  heldRead = undefined;
  heldReadStarted = new Promise((resolve) => {
    announceHeldRead = resolve;
  });
}

async function releaseHeldRead(): Promise<void> {
  const pending = heldRead;
  if (!pending) throw new Error('There is no held avatar header read');
  heldRead = undefined;
  try {
    pending.resolve(await nativeArrayBuffer.call(pending.file));
  } catch (error) {
    pending.reject(error);
    throw error;
  }
}

function exactBlobBytes(expected: ArrayBuffer, blob: Blob): Promise<boolean> {
  return nativeArrayBuffer.call(blob).then((actual) => {
    if (expected.byteLength !== actual.byteLength) return false;
    const expectedBytes = new Uint8Array(expected);
    const actualBytes = new Uint8Array(actual);
    for (let index = 0; index < expectedBytes.length; index += 1) {
      if (expectedBytes[index] !== actualBytes[index]) return false;
    }
    return true;
  });
}

function nextMediaId(): string {
  const suffix = String(0x71 + traffic.reservationIds.length).padStart(12, '0');
  return `0192f3a0-6c1e-7b2a-9d4e-${suffix}`;
}

export const Default: Story = {
  globals: { viewport: { value: 'phone390' } },
  render: () => <PageStory visitor="Signed In" path="/settings#profile" />,
  beforeEach: () => {
    traffic.media = [];
    traffic.profileWrites = [];
    traffic.reservationIds = [];
    decoderSources = [];
    fileUrls = [];
    headerReads = new WeakMap();
    heldFile = undefined;
    heldRead = undefined;
    announceHeldRead = undefined;

    nativeFetch = globalThis.fetch;
    nativeCreateImageBitmap = globalThis.createImageBitmap;
    nativeCreateObjectURL = URL.createObjectURL;
    nativeRevokeObjectURL = URL.revokeObjectURL;
    nativeArrayBuffer = Blob.prototype.arrayBuffer;
    blobArrayBufferDescriptor = Object.getOwnPropertyDescriptor(Blob.prototype, 'arrayBuffer');

    globalThis.createImageBitmap = ((source: ImageBitmapSource, options?: ImageBitmapOptions) => {
      decoderSources.push(source);
      return nativeCreateImageBitmap(source, options);
    }) as typeof createImageBitmap;
    URL.createObjectURL = ((object: Blob | MediaSource) => {
      const url = nativeCreateObjectURL.call(URL, object);
      if (isTrackedUrl(object)) fileUrls.push({ file: object, url, revocations: 0 });
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((url: string) => {
      const entry = fileUrls.find((candidate) => candidate.url === url);
      if (entry) entry.revocations += 1;
      nativeRevokeObjectURL.call(URL, url);
    }) as typeof URL.revokeObjectURL;
    Object.defineProperty(Blob.prototype, 'arrayBuffer', {
      configurable: true,
      writable: true,
      value: function (this: Blob) {
        if (this instanceof File) headerReads.set(this, (headerReads.get(this) ?? 0) + 1);
        if (this === heldFile) {
          const file = this as File;
          heldFile = undefined;
          return new Promise<ArrayBuffer>((resolve, reject) => {
            heldRead = { file, resolve, reject };
            announceHeldRead?.();
          });
        }
        return nativeArrayBuffer.call(this);
      },
    });

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === window.location.origin && url.pathname === '/media' && request.method === 'POST') {
        const body = (await request.clone().json()) as Record<string, unknown>;
        const id = nextMediaId();
        traffic.reservationIds.push(id);
        traffic.media.push({
          method: request.method,
          path: url.pathname,
          csrf: request.headers.get('X-CSRF-Token'),
          id,
          body,
        });
        return Response.json({
          media: { id, state: 'reserved', mediaType: body.mediaType, byteCount: body.byteCount },
        });
      }
      const mediaMatch = /^\/media\/([^/]+)$/.exec(url.pathname);
      if (url.origin === window.location.origin && mediaMatch) {
        const id = decodeURIComponent(mediaMatch[1]!);
        if (request.method === 'PUT') {
          const bytes = await request.clone().blob();
          const source = init?.body instanceof Blob ? init.body : undefined;
          traffic.media.push({
            method: request.method,
            path: url.pathname,
            csrf: request.headers.get('X-CSRF-Token'),
            id,
            bytes,
            ...(source ? { source } : {}),
          });
          return new Response(null, { status: 204 });
        }
        if (request.method === 'GET') {
          traffic.media.push({
            method: request.method,
            path: url.pathname,
            csrf: request.headers.get('X-CSRF-Token'),
            id,
          });
          const upload = traffic.media.find((record) => record.method === 'PUT' && record.id === id);
          return Response.json({
            media: {
              id,
              state: 'available',
              mediaType: upload?.bytes?.type ?? 'image/png',
              byteCount: upload?.bytes?.size ?? 0,
            },
          });
        }
      }
      if (
        url.origin === 'http://kernel.local' &&
        request.method === 'PATCH' &&
        /^\/v1\/accounts\/[^/]+$/.test(url.pathname)
      ) {
        traffic.profileWrites.push({
          method: request.method,
          path: url.pathname,
          csrf: request.headers.get('X-CSRF-Token'),
          body: (await request.clone().json()) as Record<string, unknown>,
          idempotencyKey: request.headers.get('idempotency-key'),
        });
      }
      return nativeFetch(request);
    }) as typeof fetch;

    return () => {
      if (heldRead) void releaseHeldRead();
      globalThis.createImageBitmap = nativeCreateImageBitmap;
      URL.createObjectURL = nativeCreateObjectURL;
      URL.revokeObjectURL = nativeRevokeObjectURL;
      globalThis.fetch = nativeFetch;
      if (blobArrayBufferDescriptor) Object.defineProperty(Blob.prototype, 'arrayBuffer', blobArrayBufferDescriptor);
    };
  },
  play: async (context) => {
    await pageReady(context);
    await selectSettingsCategory(context.canvasElement, m.settings_profile_heading());
    const profile = within(
      await within(context.canvasElement).findByRole('region', { name: m.settings_profile_heading() }),
    );
    const avatar = within(profile.getByRole('group', { name: m.settings_profile_avatar() }));
    const fileInput = avatar.getByLabelText(m.settings_profile_choose_avatar());
    await userEvent.click(profile.getByRole('button', { name: m.settings_profile_preview_open() }));
    const previewElement = await profile.findByRole('region', { name: m.settings_profile_preview_heading() });
    const preview = within(previewElement);
    const previewHasLocalImage = () =>
      Array.from(previewElement.querySelectorAll('img')).some((image) =>
        image.getAttribute('src')?.startsWith('blob:'),
      );

    const uploadOriginalAndSave = async (file: File) => {
      const expected = await nativeArrayBuffer.call(file);
      const decoderCount = decoderSources.length;
      const mediaCount = traffic.media.length;
      const writeCount = traffic.profileWrites.length;
      await userEvent.upload(fileInput, file);
      await profile.findByText(m.settings_profile_crop_original_only());
      await expect(headerReads.get(file) ?? 0).toBe(1);
      await expect(profile.queryByRole('img', { name: m.settings_profile_avatar_preview() })).toBeNull();
      await expect(preview.queryByRole('img', { name: m.settings_profile_avatar_preview() })).toBeNull();
      await expect(previewHasLocalImage()).toBe(false);
      await expect(decoderSources).toHaveLength(decoderCount);
      await expect(traffic.media).toHaveLength(mediaCount);
      await expect(traffic.profileWrites).toHaveLength(writeCount);

      await userEvent.click(profile.getByRole('button', { name: m.settings_profile_crop_use_original() }));
      await profile.findByText(m.settings_profile_avatar_ready());
      const reservation = traffic.media.findLast((record) => record.method === 'POST');
      const upload = traffic.media.findLast((record) => record.method === 'PUT');
      await expect(reservation?.body).toMatchObject({
        containerId: 'story-viewer',
        purpose: 'avatar',
        mediaType: file.type,
        byteCount: file.size,
      });
      await expect(upload?.id).toBe(reservation?.id);
      await expect(upload?.bytes?.type).toBe(file.type);
      await expect(upload?.bytes?.size).toBe(file.size);
      await expect(upload?.bytes ? await exactBlobBytes(expected, upload.bytes) : false).toBe(true);
      await expect(decoderSources).toContain(file);
      await expect(traffic.profileWrites).toHaveLength(writeCount);

      await userEvent.click(profile.getByRole('button', { name: m.settings_profile_save() }));
      await profile.findByText(m.settings_saved());
      await waitFor(() => expect(traffic.profileWrites).toHaveLength(writeCount + 1));
      await expect(traffic.profileWrites.at(-1)?.body?.avatar).toBe(reservation?.id);
      await expect(traffic.profileWrites.at(-1)?.path).toBe('/v1/accounts/story-viewer');
      return reservation?.id;
    };

    const oversizedPng = await canvasImage(16_385, 1, 'image/png', 'oversized-axis.png');
    await uploadOriginalAndSave(oversizedPng);

    const oversizedJpeg = await canvasImage(16_385, 1, 'image/jpeg', 'oversized-axis.jpg');
    await uploadOriginalAndSave(oversizedJpeg);

    const noDecode = decoderSources.length;
    const noMedia = traffic.media.length;
    const noWrites = traffic.profileWrites.length;
    for (const file of malformedFiles()) {
      await userEvent.upload(fileInput, file);
      await profile.findByText(m.settings_profile_crop_original_only());
      await expect(headerReads.get(file) ?? 0).toBe(file.type === 'image/png' || file.type === 'image/jpeg' ? 1 : 0);
      await expect(profile.queryByRole('img', { name: m.settings_profile_avatar_preview() })).toBeNull();
      await expect(preview.queryByRole('img', { name: m.settings_profile_avatar_preview() })).toBeNull();
      await expect(previewHasLocalImage()).toBe(false);
      await expect(decoderSources).toHaveLength(noDecode);
      await expect(traffic.media).toHaveLength(noMedia);
      await expect(traffic.profileWrites).toHaveLength(noWrites);
      await expect(profile.getByRole('button', { name: m.settings_profile_crop_use_original() })).toBeVisible();
    }

    const replacedPending = pngHeader(24, 20);
    holdNextRead(replacedPending);
    await userEvent.upload(fileInput, replacedPending);
    await profile.findByText(m.settings_profile_crop_preparing());
    await heldReadStarted;
    const ordinary = await canvasImage(480, 720, 'image/png', 'ordinary.png');
    const ordinaryDecoderCount = decoderSources.length;
    await userEvent.upload(fileInput, ordinary);
    const crop = within(await profile.findByRole('region', { name: m.settings_profile_crop_heading() }));
    await expect(decoderSources.slice(ordinaryDecoderCount)).toContain(ordinary);
    await expect(headerReads.get(ordinary)).toBe(1);
    await expect(traffic.media).toHaveLength(noMedia);
    await expect(traffic.profileWrites).toHaveLength(noWrites);
    await waitFor(() => expect(previewHasLocalImage()).toBe(true));
    const replacementPreviewSource = previewElement.querySelector('img[src^="blob:"]')?.getAttribute('src');
    await expect(replacementPreviewSource).toBeTruthy();
    await releaseHeldRead();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(headerReads.get(replacedPending)).toBe(1);
    await expect(headerReads.get(ordinary)).toBe(1);
    await waitFor(() => expect(decoderSources.filter((source) => source === replacedPending)).toHaveLength(0));
    await expect(crop.getByRole('button', { name: m.settings_profile_crop_apply() })).toBeEnabled();
    await expect(previewElement.querySelector('img[src^="blob:"]')?.getAttribute('src')).toBe(replacementPreviewSource);
    await expect(traffic.media).toHaveLength(noMedia);
    await expect(traffic.profileWrites).toHaveLength(noWrites);
    await expect(profile.getByRole('button', { name: m.settings_profile_save() })).toBeDisabled();

    await userEvent.click(crop.getByRole('button', { name: m.settings_profile_crop_apply() }));
    await profile.findByText(m.settings_profile_avatar_ready());
    const cropReservation = traffic.media.findLast((record) => record.method === 'POST');
    const cropUpload = traffic.media.findLast((record) => record.method === 'PUT');
    await expect(traffic.media.filter((record) => record.method === 'POST')).toHaveLength(3);
    await expect(traffic.media.filter((record) => record.method === 'PUT')).toHaveLength(3);
    await expect(cropReservation?.body).toMatchObject({
      containerId: 'story-viewer',
      purpose: 'avatar',
      mediaType: 'image/png',
    });
    const exported = await nativeCreateImageBitmap(cropUpload!.bytes!);
    try {
      await expect(exported.width).toBe(exported.height);
      await expect(exported.width).toBeLessThanOrEqual(512);
    } finally {
      exported.close();
    }
    const save = profile.getByRole('button', { name: m.settings_profile_save() });
    await expect(save).toBeEnabled();
    await userEvent.click(save);
    await profile.findByText(m.settings_saved());
    await waitFor(() => expect(traffic.profileWrites).toHaveLength(noWrites + 1));
    await expect(traffic.profileWrites.at(-1)?.body?.avatar).toBe(cropReservation?.id);

    const ordinaryJpeg = await canvasImage(640, 480, 'image/jpeg', 'ordinary.jpg');
    const jpegDecoderCount = decoderSources.length;
    const jpegMediaCount = traffic.media.length;
    const jpegPostCount = traffic.media.filter((record) => record.method === 'POST').length;
    const jpegPutCount = traffic.media.filter((record) => record.method === 'PUT').length;
    const jpegWriteCount = traffic.profileWrites.length;
    await userEvent.upload(fileInput, ordinaryJpeg);
    const jpegCrop = within(await profile.findByRole('region', { name: m.settings_profile_crop_heading() }));
    await expect(decoderSources.slice(jpegDecoderCount)).toContain(ordinaryJpeg);
    await expect(headerReads.get(ordinaryJpeg)).toBe(1);
    await expect(traffic.media).toHaveLength(jpegMediaCount);
    await expect(traffic.profileWrites).toHaveLength(jpegWriteCount);
    await userEvent.click(jpegCrop.getByRole('button', { name: m.settings_profile_crop_apply() }));
    await profile.findByText(m.settings_profile_avatar_ready());
    const jpegReservation = traffic.media.findLast((record) => record.method === 'POST');
    const jpegUpload = traffic.media.findLast((record) => record.method === 'PUT');
    await expect(traffic.media.filter((record) => record.method === 'POST')).toHaveLength(jpegPostCount + 1);
    await expect(traffic.media.filter((record) => record.method === 'PUT')).toHaveLength(jpegPutCount + 1);
    await expect(jpegReservation?.body).toMatchObject({
      containerId: 'story-viewer',
      purpose: 'avatar',
      mediaType: 'image/png',
    });
    const jpegExported = await nativeCreateImageBitmap(jpegUpload!.bytes!);
    try {
      await expect(jpegExported.width).toBe(jpegExported.height);
      await expect(jpegExported.width).toBeLessThanOrEqual(512);
    } finally {
      jpegExported.close();
    }
    await userEvent.click(profile.getByRole('button', { name: m.settings_profile_save() }));
    await profile.findByText(m.settings_saved());
    await waitFor(() => expect(traffic.profileWrites).toHaveLength(jpegWriteCount + 1));
    await expect(traffic.profileWrites.at(-1)?.body?.avatar).toBe(jpegReservation?.id);

    const cancelledPending = pngHeader(24, 20);
    holdNextRead(cancelledPending);
    await userEvent.upload(fileInput, cancelledPending);
    await profile.findByText(m.settings_profile_crop_preparing());
    await heldReadStarted;
    await userEvent.click(profile.getByRole('button', { name: m.settings_profile_avatar_cancel() }));
    await profile.findByText(m.settings_profile_avatar_cancelled());
    const beforeLateCancelResolve = decoderSources.length;
    await releaseHeldRead();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(headerReads.get(cancelledPending)).toBe(1);
    await waitFor(() => expect(decoderSources).toHaveLength(beforeLateCancelResolve));
    await expect(traffic.media.filter((record) => record.method === 'POST')).toHaveLength(4);
    await expect(traffic.media.filter((record) => record.method === 'PUT')).toHaveLength(4);
    await expect(traffic.profileWrites).toHaveLength(noWrites + 2);
    await expect(profile.getByRole('button', { name: m.settings_profile_save() })).toBeDisabled();
    await expect(previewHasLocalImage()).toBe(false);
    await waitFor(() => expect(fileUrls.length).toBeGreaterThan(0));
    await waitFor(() => expect(fileUrls.every((entry) => entry.revocations === 1)).toBe(true));
  },
};
