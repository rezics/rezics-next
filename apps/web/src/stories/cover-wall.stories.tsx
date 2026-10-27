import type { Meta, StoryObj } from '@storybook/react-vite';
import { DropdownMenuItem } from '@rezics/ui/shadcn/dropdown-menu';
import { sharedRatio, type CoverSubject, type CoverSummary } from '@rezics/ui/cover';
import { CoverCard, CoverGrid, type CoverDensity } from '@rezics/ui/cover-card';
import { ProgressRow } from '@rezics/ui/progress-row';

type Tile = {
  subject: CoverSubject;
  creator: string;
  image: boolean;
  progress?: { value: number; label: string };
  state?: string;
};

const tiles: Tile[] = [
  {
    subject: { id: 'wall-book-1', title: 'The Wind-Up Bird Chronicle', types: ['schema:Book'] },
    creator: 'Haruki Murakami',
    image: true,
    progress: { value: 0.1, label: '10%' },
  },
  {
    subject: { id: 'wall-person-1', title: 'Kaori Miyazono', types: ['schema:Person'] },
    creator: 'Your Lie in April',
    image: false,
    state: 'Following',
  },
  {
    subject: { id: 'wall-album-1', title: 'Kind of Blue', types: ['schema:MusicAlbum'] },
    creator: 'Miles Davis',
    image: true,
    state: 'Completed',
  },
  {
    subject: { id: 'wall-book-2', title: 'The Left Hand of Darkness', types: ['schema:Book'] },
    creator: 'Ursula K. Le Guin',
    image: false,
    progress: { value: 0.35, label: '35%' },
  },
  {
    subject: { id: 'wall-person-2', title: 'Saber', types: ['schema:Person'] },
    creator: 'Fate/stay night',
    image: true,
    state: 'Planned',
  },
  {
    subject: { id: 'wall-album-2', title: 'Blue Train', types: ['schema:MusicAlbum'] },
    creator: 'John Coltrane',
    image: false,
    progress: { value: 0.6, label: 'Track 6/10' },
  },
  {
    subject: { id: 'wall-book-3', title: 'Piranesi', types: ['schema:Book'] },
    creator: 'Susanna Clarke',
    image: true,
    state: 'Planned',
  },
  {
    subject: { id: 'wall-person-3', title: 'Frieren', types: ['schema:Person'] },
    creator: 'Frieren: Beyond Journey’s End',
    image: false,
    state: 'Following',
  },
  {
    subject: { id: 'wall-album-3', title: 'A Love Supreme', types: ['schema:MusicAlbum'] },
    creator: 'John Coltrane',
    image: true,
    state: 'Completed',
  },
  {
    subject: { id: 'wall-book-4', title: 'A Wizard of Earthsea', types: ['schema:Book'] },
    creator: 'Ursula K. Le Guin',
    image: false,
    state: 'Planned',
  },
  {
    subject: { id: 'wall-person-4', title: 'Shinobu Kocho', types: ['schema:Person'] },
    creator: 'Demon Slayer',
    image: true,
    progress: { value: 0.9, label: '90%' },
  },
  {
    subject: { id: 'wall-album-4', title: 'Mingus Ah Um', types: ['schema:MusicAlbum'] },
    creator: 'Charles Mingus',
    image: false,
    state: 'Planned',
  },
  {
    subject: { id: 'wall-book-5', title: 'The Dispossessed', types: ['schema:Book'] },
    creator: 'Ursula K. Le Guin',
    image: true,
    state: 'Completed',
  },
  {
    subject: { id: 'wall-book-6', title: 'The Memory Police', types: ['schema:Book'] },
    creator: 'Yōko Ogawa',
    image: false,
    state: 'Planned',
  },
];

function imageFor(subject: CoverSubject): CoverSummary {
  return {
    media: subject.id,
    width: 900,
    height: 1260,
    placeholder: { thumbhash: '', color: '#465c72' },
    variants: [{ format: 'webp', width: 640 }],
    focalPoint: null,
    credit: null,
  };
}

function imageSrc(media: string): string {
  const hue = (media.length * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 1260"><rect width="900" height="1260" fill="hsl(${hue} 45% 38%)"/><circle cx="650" cy="340" r="210" fill="hsl(${(hue + 55) % 360} 70% 75%)"/><path d="M0 900 Q430 680 900 940 V1260 H0Z" fill="hsl(${(hue + 190) % 360} 35% 18%)"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const ratio = sharedRatio(tiles.map(({ subject }) => subject));
const meta = { title: 'Rezics UI/Cover wall', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Wall({ density }: { density?: CoverDensity }) {
  return (
    <main className="w-full p-4">
      <CoverGrid ratio={ratio} {...(density ? { density } : {})}>
        {tiles.map(({ subject, creator, image, progress, state }) => (
          <CoverCard
            key={subject.id}
            href={`/subjects/${subject.id}`}
            title={subject.title}
            cover={{ subject, cover: image ? imageFor(subject) : null, src: imageSrc }}
            secondary={creator}
            state={progress ? <ProgressRow value={progress.value} label={progress.label} /> : state}
            menuLabel={`More actions for ${subject.title}`}
            menu={<DropdownMenuItem>Remove</DropdownMenuItem>}
          />
        ))}
      </CoverGrid>
    </main>
  );
}

export const Default: Story = { render: () => <Wall /> };
export const Small: Story = { render: () => <Wall density="small" /> };
export const Large: Story = { render: () => <Wall density="large" /> };
