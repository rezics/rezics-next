import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';
import { selectSettingsCategory } from './settings-category-navigation';

type MediaRecord = {
  method: string;
  path: string;
  csrf: string | null;
  idempotencyKey?: string | null;
  body?: Record<string, unknown>;
  bytes?: Blob;
};

const avatarMediaId = '0192f3a0-6c1e-7b2a-9d4e-000000000071';
const traffic: { media: MediaRecord[]; profileWrites: MediaRecord[] } = { media: [], profileWrites: [] };
let releaseFirstDecode: (() => Promise<void>) | undefined;
let firstDecodeReady: Promise<void> = Promise.resolve();

const meta = {
  title: 'Account/Avatar crop',
  id: 'pages-settings-avatar-crop',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

async function nonSquareImage(width: number, height: number, color: string, name: string): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create the local image fixture');
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#f4cf49';
  context.fillRect(
    Math.floor(width * 0.65),
    Math.floor(height * 0.65),
    Math.ceil(width * 0.25),
    Math.ceil(height * 0.25),
  );
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error('Could not encode the local image fixture'))),
      'image/png',
    );
  });
  return new File([blob], name, { type: 'image/png', lastModified: 1 });
}

export const Default: Story = {
  globals: {},
  render: () => <PageStory visitor="Signed In" path="/settings#reading" />,
  beforeEach: () => {
    traffic.media = [];
    traffic.profileWrites = [];
    releaseFirstDecode = undefined;
    const originalFetch = globalThis.fetch;
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    let holdFirstDecode = true;
    let announceFirstDecode!: () => void;
    firstDecodeReady = new Promise((resolve) => {
      announceFirstDecode = resolve;
    });
    globalThis.createImageBitmap = ((source: ImageBitmapSource, options?: ImageBitmapOptions) => {
      if (!holdFirstDecode) return originalCreateImageBitmap(source, options);
      holdFirstDecode = false;
      announceFirstDecode();
      let release: (() => Promise<void>) | undefined;
      let released = false;
      const bitmap = new Promise<ImageBitmap>((resolve, reject) => {
        release = async () => {
          if (released) return;
          released = true;
          try {
            resolve(await originalCreateImageBitmap(source, options));
          } catch (error) {
            reject(error);
          }
        };
      });
      releaseFirstDecode = () => {
        if (!release) throw new Error('The first image decode was not held');
        return release();
      };
      return bitmap;
    }) as typeof createImageBitmap;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === window.location.origin && url.pathname === '/media' && request.method === 'POST') {
        const body = (await request.clone().json()) as Record<string, unknown>;
        traffic.media.push({
          method: request.method,
          path: url.pathname,
          csrf: request.headers.get('X-CSRF-Token'),
          body,
        });
        return Response.json({
          media: {
            id: avatarMediaId,
            state: 'reserved',
            mediaType: body.mediaType,
            byteCount: body.byteCount,
          },
        });
      }
      if (url.origin === window.location.origin && url.pathname === `/media/${avatarMediaId}`) {
        if (request.method === 'PUT') {
          const bytes = await request.clone().blob();
          traffic.media.push({
            method: request.method,
            path: url.pathname,
            csrf: request.headers.get('X-CSRF-Token'),
            bytes,
          });
          return new Response(null, { status: 204 });
        }
        if (request.method === 'GET') {
          traffic.media.push({ method: request.method, path: url.pathname, csrf: request.headers.get('X-CSRF-Token') });
          const upload = traffic.media.find((record) => record.method === 'PUT');
          return Response.json({
            media: {
              id: avatarMediaId,
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
      return originalFetch(request);
    }) as typeof fetch;
    return () => {
      void releaseFirstDecode?.();
      globalThis.createImageBitmap = originalCreateImageBitmap;
      globalThis.fetch = originalFetch;
    };
  },
  play: async (context) => {
    await pageReady(context);
    await selectSettingsCategory(context.canvasElement, m.settings_profile_heading());
    const profile = within(
      await within(context.canvasElement).findByRole('region', { name: m.settings_profile_heading() }),
    );
    const avatar = within(profile.getByRole('group', { name: m.settings_profile_avatar() }));
    const name = profile.getByRole('textbox', { name: m.settings_profile_display_name() });
    await userEvent.clear(name);
    await userEvent.type(name, 'Avery Crop Journey');
    const landscape = await nonSquareImage(720, 480, '#326c91', 'landscape.png');
    const portrait = await nonSquareImage(480, 720, '#bf6849', 'portrait.png');
    const fileInput = avatar.getByLabelText(m.settings_profile_choose_avatar());

    await userEvent.upload(fileInput, landscape);
    await profile.findByText(m.settings_profile_crop_preparing());
    await firstDecodeReady;
    await expect(traffic.media).toHaveLength(0);
    await expect(traffic.profileWrites).toHaveLength(0);
    await userEvent.click(profile.getByRole('button', { name: m.settings_profile_avatar_cancel() }));
    await profile.findByText(m.settings_profile_avatar_cancelled());
    await expect(profile.queryByRole('region', { name: m.settings_profile_crop_heading() })).toBeNull();

    await userEvent.upload(fileInput, portrait);
    const crop = within(await profile.findByRole('region', { name: m.settings_profile_crop_heading() }));
    const preview = await crop.findByRole('img', { name: m.settings_profile_crop_preview() });
    const previewImage = preview.querySelector('img');
    const selectedPreviewUrl = previewImage?.getAttribute('src');
    await expect(previewImage).toBeTruthy();
    const previewBounds = preview.getBoundingClientRect();
    await expect(previewBounds.width).toBeGreaterThan(0);
    await expect(Math.abs(previewBounds.width - previewBounds.height)).toBeLessThan(1);
    const zoom = crop.getByRole('slider', { name: m.settings_profile_crop_zoom() });
    zoom.focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    await expect(zoom).toHaveValue('120');
    const vertical = crop.getByRole('slider', { name: m.settings_profile_crop_vertical() });
    vertical.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(vertical).toHaveValue('51');
    const horizontal = crop.getByRole('slider', { name: m.settings_profile_crop_horizontal() });
    horizontal.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(horizontal).toHaveValue('51');
    const viewportWidth = context.canvasElement.ownerDocument.defaultView?.innerWidth ?? 0;
    await expect(
      crop.getByRole('slider', { name: m.settings_profile_crop_horizontal() }).getBoundingClientRect().width,
    ).toBeLessThanOrEqual(viewportWidth);
    await expect(
      crop.getByRole('button', { name: m.settings_profile_crop_apply() }).getBoundingClientRect().right,
    ).toBeLessThanOrEqual(viewportWidth + 1);
    await expect(traffic.media).toHaveLength(0);
    await expect(traffic.profileWrites).toHaveLength(0);
    await expect(name).toHaveValue('Avery Crop Journey');

    const cancel = profile.getByRole('button', { name: m.settings_profile_avatar_cancel() });
    await userEvent.click(cancel);
    await profile.findByText(m.settings_profile_avatar_cancelled());
    await expect(profile.getByText(m.settings_profile_avatar_empty())).toBeVisible();
    await expect(profile.queryByRole('img', { name: m.settings_profile_avatar_preview() })).toBeNull();
    await expect(name).toHaveValue('Avery Crop Journey');
    await expect(traffic.media).toHaveLength(0);
    await expect(traffic.profileWrites).toHaveLength(0);

    await userEvent.upload(fileInput, portrait);
    const nextCrop = within(await profile.findByRole('region', { name: m.settings_profile_crop_heading() }));
    const nextPreview = await nextCrop.findByRole('img', { name: m.settings_profile_crop_preview() });
    const nextSource = nextPreview.querySelector('img')?.getAttribute('src');
    await expect(nextSource).not.toBe(selectedPreviewUrl);
    await releaseFirstDecode?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await waitFor(() => expect(nextPreview.querySelector('img')?.getAttribute('src')).toBe(nextSource));
    await expect(traffic.media).toHaveLength(0);
    const nextZoom = nextCrop.getByRole('slider', { name: m.settings_profile_crop_zoom() });
    nextZoom.focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    const nextVertical = nextCrop.getByRole('slider', { name: m.settings_profile_crop_vertical() });
    nextVertical.focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    await userEvent.click(nextCrop.getByRole('button', { name: m.settings_profile_crop_apply() }));
    await profile.findByText(m.settings_profile_avatar_ready());
    await expect(traffic.media.filter((record) => record.method === 'POST')).toHaveLength(1);
    await expect(traffic.media.filter((record) => record.method === 'PUT')).toHaveLength(1);
    const reservation = traffic.media.find((record) => record.method === 'POST')!;
    const upload = traffic.media.find((record) => record.method === 'PUT')!;
    await expect(reservation.body).toMatchObject({
      containerId: 'story-viewer',
      purpose: 'avatar',
      mediaType: 'image/png',
    });
    await expect(reservation.csrf).toBe('story-csrf-token');
    await expect(upload.csrf).toBe('story-csrf-token');
    const exported = await createImageBitmap(upload.bytes!);
    try {
      await expect(exported.width).toBe(exported.height);
      await expect(exported.width).toBeLessThanOrEqual(512);
    } finally {
      exported.close();
    }
    await expect(profile.getByRole('button', { name: m.settings_profile_save() })).toBeEnabled();
    await expect(traffic.profileWrites).toHaveLength(0);
    await userEvent.click(profile.getByRole('button', { name: m.settings_profile_save() }));
    await profile.findByText(m.settings_saved());
    await expect(traffic.profileWrites).toHaveLength(1);
    await expect(traffic.profileWrites[0]!.path).toBe('/v1/accounts/story-viewer');
    await expect(traffic.profileWrites[0]!.body).toEqual({
      avatar: avatarMediaId,
      displayName: 'Avery Crop Journey',
    });
    await expect(traffic.profileWrites[0]!.csrf).toBe('story-csrf-token');
    const idempotencyKeyHeader = traffic.profileWrites[0]!.idempotencyKey;
    await expect(idempotencyKeyHeader).toMatch(
      /^"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"$/i,
    );
    await expect(JSON.parse(idempotencyKeyHeader!)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  },
};
