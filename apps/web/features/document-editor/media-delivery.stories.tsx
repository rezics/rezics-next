import type { Meta, StoryObj } from '@storybook/react-vite';
import { fromMarkdown } from '@rezics/document';
import { Button } from '@rezics/ui/button';
import { MediaImageProvider, ResolvedMediaImages, mediaImageKey, type MediaImageMetadata } from '@rezics/ui/media-image';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { browserMainApi } from '../api/browser.ts';
import { imageReferenceFromUrl, resolveMediaMetadata } from '../api/media-metadata.ts';
import { anonymousMediaViewer } from '../api/media-viewer.ts';
import { ReaderText } from '../work-page/reader.tsx';
import { mediaMessages } from './media-messages.ts';

type MetadataAnswer = NonNullable<Awaited<ReturnType<ReturnType<typeof browserMainApi>['v1']['media']['metadata']['post']>>['data']>;
type Persona = 'visitor' | 'stranger' | 'member' | 'owner' | 'moderator' | 'operator';
type State = 'open' | 'closed' | 'empty' | 'loading' | 'error';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const native = (n: number) => `https://rezics.com/id/${id(n)}`;
const representation = id(1), closedUse = id(2), independentUse = id(3);
const people: Record<Exclude<Persona, 'visitor'>, string> = {
  stranger: native(10), member: native(11), owner: native(12), moderator: native(13), operator: native(14),
};
const reference = (use: string) => ({ representationId: representation, mediaUseId: use });
const bytePath = (use: string) => `/v1/media/representations/${representation}/bytes?use=${use}`;
const document = fromMarkdown(`Aster's original illustration appears in two independent places.

![Realm illustration](${bytePath(closedUse)})

![Independent public illustration](${bytePath(independentUse)})

Illustration by [Aster](${people.member}).`, 'blocks');

function descriptor(use: string, persona: Persona): Extract<MetadataAnswer['items'][number], { status: 'available' }> {
  const control = { target: { component: native(1), definition: 'https://rezics.com/definition/media-nsfw-v1',
    occurrence: null, context: 'urn:rezics:context:global' },
  basis: { head: null, epoch: '0', protection: null }, valueHead: null, locked: false,
  canEdit: persona === 'member', canProtect: false };
  return { status: 'available', representation, use, asset: id(4), sha256: 'a'.repeat(64),
    mediaType: 'image/png', width: 480, height: 240, url: bytePath(use), nsfw: 'sfw',
    ageRating: { status: 'unassessed', displayLabel: 'Not assessed' }, conceal: false, coverCredit: null,
    canEdit: persona === 'member', canProtect: false,
    controls: { nsfw: control, ageRating: { ...control, target: { ...control.target,
      definition: 'https://rezics.com/definition/media-ageRating-v1' } }, conceal: null } };
}

/** No closure-media answers have been recorded. These are contract-built states,
 * passed through the typed production client and the production document reader.
 * Only the final byte transport maps to this story-authored original PNG. */
function samplePng() {
  const canvas = window.document.createElement('canvas');
  canvas.width = 480; canvas.height = 240;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#d3e5ec'; context.fillRect(0, 0, 480, 240);
  context.fillStyle = '#446e82'; context.beginPath();
  context.moveTo(0, 200); context.lineTo(120, 90); context.lineTo(240, 180);
  context.lineTo(350, 50); context.lineTo(480, 190); context.lineTo(480, 240); context.lineTo(0, 240); context.fill();
  const data = atob(canvas.toDataURL('image/png').split(',')[1]!);
  return URL.createObjectURL(new Blob([Uint8Array.from(data, char => char.charCodeAt(0))], { type: 'image/png' }));
}

function MediaDocument({ persona = 'visitor', state = 'closed', locale = 'en', serverResolved = false }: {
  persona?: Persona; state?: State; locale?: UiLocale; serverResolved?: boolean;
}) {
  const src = useMemo(samplePng, []);
  useEffect(() => () => URL.revokeObjectURL(src), [src]);
  const [refreshed, setRefreshed] = useState(false);
  const actor = persona === 'visitor' ? undefined : people[persona];
  const viewer = useMemo(() => ({ ...anonymousMediaViewer, signedIn: !!actor }), [actor]);
  const resolve = useCallback(async (references: Parameters<typeof resolveMediaMetadata>[0]) => {
    const send = (async (input, init) => {
      await expect(new URL(String(input)).pathname).toBe('/api/main/v1/media/metadata');
      await expect(init?.credentials).toBe(actor ? 'same-origin' : 'omit');
      const request = JSON.parse(String(init?.body));
      await expect(request).toEqual({ items: references.map(ref => ({ representation: ref.representationId,
        use: ref.mediaUseId })), ...(actor ? { actingSubject: actor } : {}) });
      if (state === 'loading') return new Promise<Response>(() => {});
      if (state === 'error') return Response.json({ type: 'https://rezics.com/problems/media_unavailable', code: 'media_unavailable',
        title: 'Media owner is unavailable', status: 503 }, { status: 503 });
      const closed = refreshed || state !== 'open';
      const answer: MetadataAnswer = { items: references.map(ref => state === 'empty'
        || closed && ref.mediaUseId === closedUse
        ? { status: 'unavailable', reference: { representation, use: ref.mediaUseId } }
        : descriptor(ref.mediaUseId!, persona)) };
      return Response.json(answer);
    }) as typeof fetch;
    const images = await resolveMediaMetadata(references, actor, send);
    return images.map(image => ({ ...image, src }));
  }, [actor, persona, refreshed, src, state]);
  const initial = useMemo(() => Object.fromEntries([closedUse, independentUse].map(use => [mediaImageKey(reference(use)), {
    ...reference(use), src, nsfw: 'sfw', ageRating: { status: 'unassessed' },
  } satisfies MediaImageMetadata])), [src]);
  const body = <article className="mx-auto grid max-w-2xl gap-4 p-4 sm:p-8 [&_img]:w-full" lang="en">
    <h1 className="text-2xl font-semibold">The surveyor's sketchbook</h1>
    <ReaderText lines={null} document={document} formatNote="" locale={locale} />
    {serverResolved ? <Button onClick={() => setRefreshed(true)}>Refresh viewing state</Button> : null}
  </article>;
  return <MediaImageProvider viewer={viewer} referenceFromUrl={imageReferenceFromUrl}
    labels={mediaMessages[locale]} refreshKey={`${actor ?? 'visitor'}:${refreshed}`} resolve={resolve}>
    {serverResolved ? <ResolvedMediaImages images={initial}>{body}</ResolvedMediaImages> : body}
  </MediaImageProvider>;
}

const meta = {
  title: 'Media/Realm closure delivery', component: MediaDocument,
  globals: { viewport: { value: 'desktop' } },
  parameters: {
    docs: { description: { component: 'Contract-built: realm/closure-media has no recorded answers. POST /v1/media/metadata with exact representation/use pairs and each eligible Person. Open: both available. Closed: Realm Use unavailable, independent global Use available. Empty: both unavailable. Error: HTTP 503 media_unavailable. Loading: request unresolved. Metadata declares no HTTP 202 state. Original illustration credited to the member Person; Realm owner is a different Person. Operator has no inspection grant.' } },
  },
} satisfies Meta<typeof MediaDocument>;
export default meta;
type Story = StoryObj<typeof meta>;

const closed: Story = {
  async play({ canvasElement, args }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(mediaMessages[args.locale ?? 'en'].unavailable)).toBeVisible();
    await expect(await canvas.findByRole('img', { name: 'Independent public illustration' })).toBeVisible();
    await expect(canvas.queryByRole('img', { name: 'Realm illustration' })).toBeNull();
    await expect(canvas.getByRole('link', { name: 'Aster' })).toHaveAttribute('href', people.member);
  },
};
export const Visitor: Story = { ...closed };
export const Stranger: Story = { ...closed, args: { persona: 'stranger' } };
export const Member: Story = { ...closed, args: { persona: 'member' } };
export const RealmOwner: Story = { ...closed, args: { persona: 'owner' } };
export const JoinedModerator: Story = { ...closed, args: { persona: 'moderator' } };
export const OperatorWithoutInspection: Story = { ...closed, args: { persona: 'operator' } };
export const Phone: Story = { ...closed, globals: { viewport: { value: 'phone' } } };
export const TraditionalChinese: Story = { ...closed, args: { locale: 'zh-Hant' }, globals: { locale: 'zh-Hant' } };
export const SimplifiedChinese: Story = { ...closed, args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans' } };
export const Japanese: Story = { ...closed, args: { locale: 'ja' }, globals: { locale: 'ja' } };
export const Korean: Story = { ...closed, args: { locale: 'ko' }, globals: { locale: 'ko' } };
export const German: Story = { ...closed, args: { locale: 'de' }, globals: { locale: 'de' } };
export const French: Story = { ...closed, args: { locale: 'fr' }, globals: { locale: 'fr' } };
export const Spanish: Story = { ...closed, args: { locale: 'es' }, globals: { locale: 'es' } };
export const Populated: Story = { args: { state: 'open' }, globals: { viewport: { value: 'desktop' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('img', { name: 'Realm illustration' })).toBeVisible();
    await expect(await canvas.findByRole('img', { name: 'Independent public illustration' })).toBeVisible();
  },
};
export const PopulatedPhone: Story = { ...Populated, globals: { viewport: { value: 'phone' } } };
export const Loading: Story = { args: { state: 'loading' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryAllByRole('img')).toHaveLength(0);
    await expect(canvas.getAllByText(mediaMessages.en.loading)).toHaveLength(2);
  },
};
export const Empty: Story = { args: { state: 'empty' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getAllByText(mediaMessages.en.unavailable)).toHaveLength(2));
    await expect(canvas.queryAllByRole('img')).toHaveLength(0);
  },
};
export const Error: Story = { ...Empty, args: { state: 'error' } };
export const ClosureAfterServerRead: Story = { args: { state: 'open', persona: 'member', serverResolved: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('img', { name: 'Realm illustration' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Refresh viewing state' }));
    await expect(await canvas.findByText(mediaMessages.en.unavailable)).toBeVisible();
    await expect(canvas.queryByRole('img', { name: 'Realm illustration' })).toBeNull();
    await expect(await canvas.findByRole('img', { name: 'Independent public illustration' })).toBeVisible();
  },
};
