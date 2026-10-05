import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Button } from './button.tsx';
import { ImageSettings } from './image-settings.tsx';
import { RichTextEditor } from './rich-text-editor.tsx';
import type { DocumentSnapshot } from '@rezics/document';
import { MediaImage, MediaImageProvider, mediaImageKey, ResolvedMediaImages, type MediaImageMetadata, type MediaImageViewer } from './media-image.tsx';

const viewer: MediaImageViewer = { ready: true, signedIn: true, age: 'adult',
  optIns: { general: true, r15: true, sexual: true, grotesque: false }, nsfwDisplay: 'mask' };
const source = () => URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="480" height="260"><rect width="480" height="260" fill="#d3e5ec"/><path d="M0 200L120 90L240 180L350 50L480 190V260H0Z" fill="#446e82"/><circle cx="90" cy="60" r="25" fill="#fff5ba"/></svg>'], { type: 'image/svg+xml' }));
const control = { locked: false, canEdit: true, canProtect: true, valueHead: null, basis: { head: null, epoch: '0', protection: null } };

function Example({ nsfw = 'nsfw', conceal = false, rating = false, ready = true, settings = false, locked = false, admin = true }: {
  nsfw?: MediaImageMetadata['nsfw']; conceal?: boolean; rating?: boolean; ready?: boolean; settings?: boolean; locked?: boolean; admin?: boolean;
}) {
  const src = useMemo(source, []);
  const [shown, setShown] = useState(false);
  const [metadata, setMetadata] = useState<MediaImageMetadata>(() => ({ representationId: 'image-1', mediaUseId: 'use-1', src,
    nsfw, conceal, ageRating: rating ? { status: 'assessed', labels: ['r18', 'r18g'] } : { status: 'unassessed' },
    controls: { nsfw: { ...control, locked, canProtect: admin }, ageRating: { ...control, canProtect: admin }, conceal: { ...control, canProtect: admin } } }));
  const currentViewer = { ...viewer, ready, nsfwDisplay: shown ? 'show' as const : 'mask' as const };
  return <MediaImageProvider viewer={currentViewer} images={{ [mediaImageKey(metadata)]: metadata }}>
    <div className="mx-auto grid w-full max-w-lg gap-3 p-4">
      <MediaImage metadata={metadata} alt="Illustrated mountains" className="w-full" />
      <Button type="button" variant="outline" onClick={() => setShown(value => !value)}>Toggle NSFW preference</Button>
      {settings ? <ImageSettings metadata={metadata} onEditImageLabels={async ({ field, value, mode }) => {
        const next = { ...metadata, revision: crypto.randomUUID(), ...(mode === 'edit' ? { [field]: value } : {}),
          controls: { ...metadata.controls!, [field]: { ...metadata.controls![field]!, locked: mode === 'edit' ? metadata.controls![field]!.locked : mode === 'lock' } } } as MediaImageMetadata;
        setMetadata(next); return next;
      }} /> : null}
    </div>
  </MediaImageProvider>;
}
const meta = { title: 'Media/Image', component: Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NsfwMask: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('img', { name: 'Illustrated mountains' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Show image' }));
    await expect(canvas.getByRole('img', { name: 'Illustrated mountains' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Toggle NSFW preference' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Toggle NSFW preference' }));
    await expect(canvas.queryByRole('img', { name: 'Illustrated mountains' })).toBeNull();
  },
};
export const OrdinaryConcealed: Story = { args: { nsfw: 'sfw', conceal: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Toggle NSFW preference' }));
    await expect(canvas.getByRole('button', { name: 'Show image' })).toBeVisible();
    await expect(canvas.queryByRole('img')).toBeNull();
  },
};
export const IndependentAdultCategories: Story = { args: { nsfw: 'sfw', rating: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('This content is hidden by your age rating preferences.')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Show image' })).toBeNull();
    await expect(canvas.queryByRole('img')).toBeNull();
  },
};
export const PreferencesLoading: Story = { args: { nsfw: 'sfw', ready: false },
  async play({ canvasElement }) { await expect(canvasElement.querySelector('img')).toBeNull(); },
};
export const NotAssessed: Story = { args: { nsfw: 'unknown' } };
export const AdminControls: Story = { args: { settings: true, locked: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('combobox', { name: 'NSFW label' })).toBeEnabled();
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'NSFW label' }), 'sfw');
    await expect(canvas.getByRole('img', { name: 'Illustrated mountains' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Unlock NSFW label' })).toBeVisible();
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Age rating' }), 'r18,r18g');
    await waitFor(() => expect(canvas.queryByRole('img', { name: 'Illustrated mountains' })).toBeNull());
  },
};
export const AuthorLocked: Story = { args: { settings: true, locked: true, admin: false },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('combobox', { name: 'NSFW label' })).toBeDisabled();
    await expect(canvas.getByRole('combobox', { name: 'Age rating' })).toBeEnabled();
    await expect(canvas.queryByRole('button', { name: 'Unlock NSFW label' })).toBeNull();
  },
};

function Uses() {
  const src = useMemo(source, []);
  return <MediaImageProvider viewer={viewer} resolve={async refs => refs.map(ref => ({ ...ref, src, nsfw: 'sfw', ageRating: { status: 'unassessed' }, conceal: ref.mediaUseId === 'masked' }))}>
    <div className="grid max-w-lg gap-3"><MediaImage representationId="same-image" mediaUseId="visible" alt="Visible use" />
      <MediaImage representationId="same-image" mediaUseId="masked" alt="Masked use" /></div>
  </MediaImageProvider>;
}
export const SeparateUses: Story = { render: () => <Uses />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('img', { name: 'Visible use' })).toBeVisible();
    await expect(canvas.queryByRole('img', { name: 'Masked use' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Show image' }));
    await expect(canvas.getByRole('img', { name: 'Masked use' })).toBeVisible();
  },
};

function NodeEditor() {
  const src = useMemo(source, []);
  const [metadata, setMetadata] = useState<MediaImageMetadata>(() => ({ representationId: '11111111-1111-4111-8111-111111111111',
    mediaUseId: '22222222-2222-4222-8222-222222222222', src, nsfw: 'nsfw', ageRating: { status: 'unassessed' },
    controls: { nsfw: control, ageRating: control, conceal: control } }));
  const [document, setDocument] = useState<DocumentSnapshot>((): DocumentSnapshot => ({ version: 'rezics-document-v1', profile: 'blocks', doc: { type: 'doc', content: [
    { type: 'image', attrs: { id: '33333333-3333-4333-8333-333333333333', src, alt: 'Illustrated mountains', representationId: metadata.representationId, mediaUseId: metadata.mediaUseId! } },
    { type: 'paragraph', attrs: { id: 'paragraph' } },
  ] } }));
  return <MediaImageProvider viewer={viewer} images={{ [mediaImageKey(metadata)]: metadata }}><div className="mx-auto max-w-xl p-4">
    <RichTextEditor compact label="Image document" value={document} onChange={setDocument} onEditImageLabels={async ({ field, value, mode }) => {
      const next = { ...metadata, revision: crypto.randomUUID(), ...(mode === 'edit' ? { [field]: value } : {}),
        controls: { ...metadata.controls!, [field]: { ...metadata.controls![field]!, locked: mode === 'edit' ? metadata.controls![field]!.locked : mode === 'lock' } } } as MediaImageMetadata;
      setMetadata(next); return next;
    }} />
  </div></MediaImageProvider>;
}
export const SelectedDocumentImage: Story = { render: () => <NodeEditor />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Show image' }));
    await userEvent.click(canvas.getByRole('img', { name: 'Illustrated mountains' }));
    await expect(await canvas.findByRole('combobox', { name: 'NSFW label' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Lock NSFW label' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Unlock NSFW label' })).toBeVisible());
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'NSFW label' }), 'sfw');
    await expect(canvas.getByRole('button', { name: 'Unlock NSFW label' })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: 'Age rating' })).toBeEnabled();
  },
};

function Refresh() {
  const src = useMemo(source, []);
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState('');
  return <MediaImageProvider viewer={viewer} refreshKey={refresh}
    referenceFromUrl={url => url === '/managed/image' ? { representationId: 'managed' } : undefined}
    resolve={async refs => { if (!refresh) throw new Error('temporary-unavailability'); return refs.map(ref => ({ ...ref, src, nsfw: 'sfw', ageRating: { status: 'unassessed' } })); }}>
    <div className="grid max-w-md gap-3 p-4"><label>Draft<input value={draft} onChange={event => setDraft(event.target.value)} /></label>
      <MediaImage src="/managed/image" alt="Recovered image" /><Button onClick={() => setRefresh(value => value + 1)}>Refresh preferences</Button></div>
  </MediaImageProvider>;
}
export const RecoverWithoutLosingDraft: Story = { render: () => <Refresh />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Content unavailable')).toBeVisible();
    await userEvent.type(canvas.getByRole('textbox', { name: 'Draft' }), 'Keep this draft');
    await userEvent.click(canvas.getByRole('button', { name: 'Refresh preferences' }));
    await expect(await canvas.findByRole('img', { name: 'Recovered image' })).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep this draft');
  },
};

function CompactAvatar() {
  const src = useMemo(source, []);
  const metadata: MediaImageMetadata = { representationId: 'compact-avatar', src, nsfw: 'nsfw', ageRating: { status: 'unassessed' } };
  return <MediaImageProvider viewer={viewer}><div className="flex flex-wrap items-center gap-6 p-4">
    <div data-avatar="interactive" className="grid justify-items-center gap-2"><div className="size-20 overflow-hidden rounded-full"><MediaImage compact metadata={metadata}
      alt="Avatar of Aster" className="size-full object-cover" /></div><span>Aster</span></div>
    <div className="grid justify-items-center gap-2"><div className="size-20 overflow-hidden rounded-full"><MediaImage compact metadata={{ ...metadata, representationId: 'masked-avatar' }}
      alt="Avatar of Rowan" className="size-full object-cover" /></div><span>Rowan</span></div>
  </div></MediaImageProvider>;
}
export const CompactAvatarReveal: Story = { render: () => <CompactAvatar />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const mask = within(canvasElement.querySelector('[data-avatar="interactive"]') as HTMLElement).getByRole('button', { name: 'NSFW image. Show image' });
    await expect(canvas.queryByRole('img', { name: 'Avatar of Aster' })).toBeNull();
    await expect(mask.getBoundingClientRect().width).toBe(80);
    await expect(mask.getBoundingClientRect().height).toBe(80);
    await userEvent.tab();
    await expect(mask).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const image = canvas.getByRole('img', { name: 'Avatar of Aster' }) as HTMLImageElement;
    await waitFor(() => expect(image.complete && image.naturalWidth > 0).toBe(true));
    await expect(image.getBoundingClientRect().width).toBe(80);
    await expect(image.getBoundingClientRect().height).toBe(80);
  },
};

/** Metadata a server read with the page: images draw (or mask) at once and nothing is requested again. */
function ServerResolved() {
  const src = useMemo(source, []);
  const [requests, setRequests] = useState(0);
  const images = useMemo(() => Object.fromEntries((['sfw', 'nsfw'] as const).map(nsfw => [mediaImageKey({ representationId: nsfw }),
    { representationId: nsfw, src, nsfw, ageRating: { status: 'unassessed' } } satisfies MediaImageMetadata])), [src]);
  return <MediaImageProvider viewer={{ ...viewer, signedIn: false, age: 'unknown' }}
    referenceFromUrl={url => ({ representationId: url.slice(url.indexOf('#') + 1) })}
    resolve={async references => { setRequests(count => count + references.length); return []; }}>
    <ResolvedMediaImages images={images}>
      <div className="mx-auto grid w-full max-w-lg gap-3 p-4">
        <MediaImage src={`${src}#sfw`} alt="Resolved art" revealable={false} className="w-full" />
        <MediaImage src={`${src}#nsfw`} alt="Resolved NSFW art" revealable={false} className="h-32 w-full" />
        <p>{requests} metadata requests</p>
      </div>
    </ResolvedMediaImages>
  </MediaImageProvider>;
}
export const ResolvedByServer: Story = { render: () => <ServerResolved />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('img', { name: 'Resolved art' })).toBeVisible();
    await expect(canvas.getByRole('img', { name: 'NSFW image' })).toBeVisible();
    await expect(canvas.queryByRole('img', { name: 'Resolved NSFW art' })).toBeNull();
    await expect(canvas.getByText('0 metadata requests')).toBeVisible();
  },
};
