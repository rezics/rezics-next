import { Badge } from '@rezics/ui/badge';
import { WorkCover } from '@rezics/ui/work-cover';
import { cn } from '@rezics/ui/utils';
import { Check, Download, FileText, Gamepad2 } from 'lucide-react';
import { fill } from '../i18n/fill.ts';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import type { PageId } from '../pages.ts';
import { cloths, lantern, serial, shelf } from './sample.ts';

type Line = Exclude<PageId, 'home' | 'trust' | 'roadmap'>;

/** Seven Japanese volumes standing on the shelf, the next one still a dashed outline. */
function Spines() {
  const swatch = cloths.inkBlue;
  return (
    <ol className="flex items-end gap-1.5">
      {Array.from({ length: 8 }, (_, index) => index + 1).map((volume) => (
        <li
          key={volume}
          className={cn(
            'flex h-36 w-8 flex-col items-center justify-between rounded-[3px] py-2',
            volume === 8
              ? 'border-2 border-dashed border-current opacity-70'
              : 'shadow-[inset_-3px_0_0_rgb(0_0_0/0.2)]',
          )}
          style={volume === 8 ? undefined : { background: swatch.ground, color: swatch.ink }}
        >
          <span
            lang="ja"
            className={cn(
              'font-work-title text-sm font-semibold tracking-[0.12em] [writing-mode:vertical-rl]',
              volume === 8 && 'invisible',
            )}
          >
            {lantern.editions[0].title}
          </span>
          <span className="text-xs font-bold tabular-nums">{volume}</span>
        </li>
      ))}
    </ol>
  );
}

function Shelf() {
  const books = [
    shelf[0],
    {
      id: lantern.id,
      title: lantern.editions[1].title,
      lang: 'zh-Hant',
      author: lantern.author['zh-Hant'],
    },
    shelf[2],
    shelf[3],
  ];
  return (
    <div className="relative flex w-full max-w-sm items-end justify-center gap-3 border-b-[5px] border-border pb-0">
      {books.map((book, index) => (
        <div key={book.id} className="relative">
          <WorkCover
            kind="book"
            id={book.id}
            title={book.title}
            lang={book.lang}
            authors={[book.author]}
            className={cn('rounded-[4px]', index === 1 ? 'w-24' : 'w-[4.5rem]')}
          />
          {index === 1 ? <span className="ribbon absolute -top-1 end-3 h-14 w-3" /> : null}
        </div>
      ))}
    </div>
  );
}

function Chapters({ words }: { words: IllustrationCopy }) {
  const rows = [
    { n: serial.chapter - 2, state: 'read' },
    { n: serial.chapter - 1, state: 'read' },
    { n: serial.chapter, state: 'here' },
    { n: serial.chapter + 1, state: 'scheduled' },
  ] as const;
  return (
    <ul className="flex w-full max-w-xs flex-col gap-2">
      {rows.map((row) => (
        <li
          key={row.n}
          className={cn(
            'flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm',
            row.state === 'here' ? 'border-primary bg-accent' : 'border-border bg-background',
          )}
        >
          <span className="font-semibold">{fill(words.shelf.chapter, { n: row.n })}</span>
          {row.state === 'read' ? (
            <Check aria-hidden className="size-4 text-success-foreground" />
          ) : null}
          {row.state === 'here' ? (
            <span className="text-primary">{words.serial.stoppedHere}</span>
          ) : null}
          {row.state === 'scheduled' ? (
            <span className="text-muted-foreground">{words.serial.scheduled}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function Episodes() {
  return (
    <div className="grid grid-cols-6 gap-1.5">
      {Array.from({ length: 12 }, (_, index) => (
        <span
          key={index}
          className={cn(
            'flex size-9 items-center justify-center rounded-lg text-xs font-bold tabular-nums',
            index < 7 ? 'bg-(--cloth-ink) text-(--cloth)' : 'border border-current opacity-60',
          )}
        >
          {index + 1}
        </span>
      ))}
    </div>
  );
}

function Proposal({ words }: { words: IllustrationCopy }) {
  return (
    <div className="w-full max-w-xs rounded-2xl border border-border bg-background p-4 text-sm">
      <p className="flex items-center justify-between gap-2">
        <span className="font-semibold">{words.agent.proposal}</span>
        <Badge variant="info" size="sm">
          {words.agent.automated}
        </Badge>
      </p>
      <ul lang="en" className="mt-3 flex flex-wrap gap-1.5">
        {['found family', 'slow burn', 'archives'].map((tag) => (
          <li key={tag}>
            <Badge variant="outline" size="md">
              {tag}
            </Badge>
          </li>
        ))}
      </ul>
      <p className="mt-3 flex gap-2">
        <span className="rounded-full bg-primary px-3 py-1 font-semibold text-primary-foreground">
          {words.agent.accept}
        </span>
        <span className="rounded-full border border-border px-3 py-1">{words.agent.reject}</span>
      </p>
    </div>
  );
}

/** A small entity graph: people and places joined by relations, each citing its chapter. */
function Graph() {
  const nodes = [
    { x: 16, y: 26, label: 'Kaede Aoi', ch: 1 },
    { x: 62, y: 16, label: 'The Lantern Archive', ch: 4 },
    { x: 44, y: 70, label: 'Ren Tachibana', ch: 4 },
    { x: 86, y: 64, label: 'Iori Sakuma', ch: 9 },
  ];
  const edges = [
    [0, 1],
    [1, 2],
    [0, 2],
    [0, 3],
  ] as const;
  return (
    <div className="relative h-44 w-full max-w-md">
      <svg
        className="absolute inset-0 size-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {edges.map(([a, b]) => (
          <line
            key={`${a}-${b}`}
            x1={nodes[a]!.x}
            y1={nodes[a]!.y}
            x2={nodes[b]!.x}
            y2={nodes[b]!.y}
            stroke="currentColor"
            strokeOpacity="0.45"
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {nodes.map((node) => (
        <span
          key={node.label}
          lang="en"
          className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-(--cloth-ink) py-1 ps-3 pe-1 text-xs font-semibold text-(--cloth,var(--cloth-reading)) ring-1 ring-black/10"
          style={{ left: `${node.x}%`, top: `${node.y}%` }}
        >
          {node.label}
          <span className="rounded-full bg-(--cloth,var(--cloth-reading)) px-1.5 py-0.5 text-[0.625rem] text-(--cloth-ink) tabular-nums">
            {node.ch}
          </span>
        </span>
      ))}
    </div>
  );
}

function Rules() {
  const rules = [
    { lang: 'en', text: 'Mark spoilers until a volume is a month old.' },
    { lang: 'zh-Hant', text: '新書出版一個月內，請標註劇透。' },
    { lang: 'ja', text: '刊行から一か月はネタバレを明記してください。' },
  ];
  return (
    <ul className="flex w-full max-w-xs flex-col gap-2">
      {rules.map((rule) => (
        <li
          key={rule.lang}
          lang={rule.lang}
          className="rounded-xl border border-border bg-background px-3 py-2 text-sm"
        >
          {rule.text}
        </li>
      ))}
    </ul>
  );
}

function Files() {
  const files = [
    { name: 'EPUB', icon: FileText },
    { name: 'PDF', icon: FileText },
    { name: 'Windows', icon: Gamepad2 },
  ];
  return (
    <ul className="flex flex-wrap justify-center gap-2">
      {files.map(({ name, icon: Icon }) => (
        <li
          key={name}
          translate="no"
          className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm font-semibold"
        >
          <Icon aria-hidden className="size-4 text-primary" />
          {name}
          <Download aria-hidden className="size-4 text-muted-foreground" />
        </li>
      ))}
    </ul>
  );
}

function Code() {
  return (
    <pre
      lang="en"
      translate="no"
      className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-card px-4 py-3 font-mono text-[0.8125rem] leading-relaxed"
    >
      <span className="text-muted-foreground">GET</span>
      {' /works/7d1f…/editions?language=zh-Hant\n'}
      <span className="text-muted-foreground">{'200 '}</span>
      {'{ "title": "燈籠書庫", "volumes": 6 }'}
    </pre>
  );
}

/** The picture on a product line's showcase tile: one small, true scene from that line. */
export function LineVignette({ line, words }: { line: Line; words: IllustrationCopy }) {
  switch (line) {
    case 'light-novels':
      return <Spines />;
    case 'reading':
      return <Shelf />;
    case 'serial-fiction':
      return <Chapters words={words} />;
    case 'acgn':
      return <Episodes />;
    case 'agents':
      return <Proposal words={words} />;
    case 'wikis':
      return <Graph />;
    case 'communities':
      return <Rules />;
    case 'distribution':
      return <Files />;
    case 'developers':
      return <Code />;
  }
}
