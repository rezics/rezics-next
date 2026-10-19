import { MediaImageProvider, mediaImageKey } from '@rezics/ui/media-image';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { knownCoverCredit } from '../rights-mark/fixtures.ts';
import { WorkCredits } from './credits.tsx';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import { workHref } from './route.ts';
import { WorkFrame, WorkPageCover } from './work-frame.tsx';
import { WorkAbout } from './work-header.tsx';

const kinds = {
  anime: { type: 'https://schema.org/TVSeries', title: 'Lantern Harbor', width: 300, height: 450 },
  music: { type: 'https://schema.org/MusicAlbum', title: 'Tidepool Sessions', width: 400, height: 400 },
  game: { type: 'https://schema.org/VideoGame', title: 'Paper Cranes', width: 640, height: 360 },
};
type Kind = keyof typeof kinds;
const representationId = '00000000-0000-4000-8000-000000001001';
// Deliberately ordinary cover fixtures: no showcase, logo or hero is supplied.
// These decoded fixture bytes prove component consumption, not genuine catalogue acceptance.
const images = Object.fromEntries(Object.entries(kinds).map(([kind, { width, height, title }]) => [kind,
  URL.createObjectURL(new Blob([
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="#234a62"/>
      <circle cx="${width / 2}" cy="${height / 3}" r="${width / 5}" fill="#f4d997"/>
      <text x="50%" y="80%" fill="#fff" text-anchor="middle" font-size="24">${title}</text>
    </svg>`,
  ], { type: 'image/svg+xml' })),
])) as Record<Kind, string>;

function OrdinaryCover({ kind, streamed }: { kind: Kind; streamed: boolean }) {
  const { type, title, width, height } = kinds[kind];
  const work = { ...fixture.work, types: [type], title: { ...fixture.work.title, value: title },
    originalTitle: null, tagline: null, completionStatus: null, chapterCount: null, wordCount: null,
    cover: { kind: 'image' as const, selection: representationId,
      url: `/v1/media/representations/${representationId}/bytes`, mediaType: 'image/svg+xml', width, height,
      crop: null, coverCredit: knownCoverCredit, basis: { policy: 'story', context: 'story' } } };
  return <MediaImageProvider viewer={{ ready: true, signedIn: false, age: 'unknown',
    optIns: { general: true, r15: false, sexual: false, grotesque: false } }}
    images={{ [mediaImageKey({ representationId })]: { representationId, src: images[kind], nsfw: 'sfw',
      ageRating: { status: 'unassessed' }, coverCredit: knownCoverCredit } }}>
    <WorkFrame workRef={fixture.workRef} work={work} locale="en" messages={messages.en}
      cover={streamed ? <WorkPageCover work={work} /> : undefined}
      credits={<WorkCredits agentCredits={fixture.agentCredits} credits={fixture.credits} locale="en" messages={messages.en} />}>
      <WorkAbout work={work} messages={messages.en} />
    </WorkFrame>
  </MediaImageProvider>;
}

const meta = {
  title: 'Work page/Nonbook cover',
  component: OrdinaryCover,
  args: { kind: 'anime', streamed: true },
  parameters: { route: { pathname: workHref(fixture.workRef), search: '' } },
} satisfies Meta<typeof OrdinaryCover>;
export default meta;
type Story = StoryObj<typeof meta>;

async function ordinaryCover({ canvasElement, args }: { canvasElement: HTMLElement; args: { kind: Kind } }) {
  await document.fonts.ready;
  const canvas = within(canvasElement);
  const heading = canvas.getByRole('heading', { level: 1, name: kinds[args.kind].title });
  const image = canvasElement.querySelector<HTMLImageElement>('[data-slot="work-cover"] img')!;
  await expect(image).toBeVisible();
  await waitFor(() => expect(image.complete && image.naturalWidth === kinds[args.kind].width).toBe(true));
  await expect(image.currentSrc).toBe(images[args.kind]);
  await expect(canvasElement.querySelectorAll('[data-slot="work-cover"]')).toHaveLength(1);
  const subject = canvasElement.querySelector<HTMLElement>('[data-subject-header]')!;
  await expect(subject).toHaveAttribute('data-resource', fixture.work.id);
  await expect(subject).toHaveAttribute('data-semantic-type', kinds[args.kind].type);
  await expect(within(subject).getByRole('region', { name: 'Credits' })).toBeVisible();
  await expect(canvas.queryByRole('link', { name: 'Read' })).toBeNull();
  await expect(image.getBoundingClientRect().right).toBeLessThanOrEqual(heading.getBoundingClientRect().left);
  if (window.innerWidth < 640) {
    await expect(image.getBoundingClientRect().width).toBeLessThanOrEqual(104);
    await expect(heading.getBoundingClientRect().bottom).toBeLessThan(window.innerHeight);
  }
  const sources = canvas.getByRole('contentinfo', { name: 'Sources and licenses' });
  await expect(canvas.getAllByRole('contentinfo')).toHaveLength(1);
  await expect(subject.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await expect(within(sources).getByRole('link', { name: knownCoverCredit.source.name })).toBeVisible();
  await expect(within(subject).queryByRole('link', { name: knownCoverCredit.source.name })).toBeNull();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
}

export const AnimeDesktop: Story = { globals: { viewport: { value: 'desktop1440' } }, play: ordinaryCover };
export const AnimePhone: Story = { ...AnimeDesktop, globals: { viewport: { value: 'phone' } } };
export const MusicDesktop: Story = { ...AnimeDesktop, args: { kind: 'music', streamed: false } };
export const MusicPhone: Story = { ...MusicDesktop, globals: { viewport: { value: 'phone' } } };
export const GameDesktop: Story = { ...AnimeDesktop, args: { kind: 'game' } };
export const GamePhone: Story = { ...GameDesktop, globals: { viewport: { value: 'phone' } } };
