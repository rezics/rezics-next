import { Badge } from '@rezics/ui/badge';
import { buttonVariants } from '@rezics/ui/button';
import { WorkCover } from '@rezics/ui/work-cover';
import { cn } from '@rezics/ui/utils';
import { BookOpen, Check, Download, FileText, Gamepad2, Receipt, UserRound } from 'lucide-react';
import type { CSSProperties } from 'react';
import { fill } from '../i18n/fill.ts';
import { localeNames } from '../i18n/locales.ts';
import { row, type Picture, type Words } from './parts.tsx';
import { Plate } from './Plate.tsx';
import { glassTide, lantern, saltMarsh, shelf } from './sample.ts';

const at = (percent: number) => ({ '--at': percent }) as CSSProperties;

/** The Traditional Chinese edition on sale, its credited translator and the sum a buyer sees first. */
const sale = { price: '€10.00', tax: '€1.90', total: '€11.90', translator: '林映雪' } as const;

/** The edition being bought: its cover, language and credited translator. */
function EditionHeader({ words }: Words) {
  return (
    <div className="flex items-center gap-4">
      <WorkCover
        kind="book"
        id={lantern.id}
        title={lantern.editions[1].title}
        lang="zh-Hant"
        authors={[lantern.author['zh-Hant']]}
        className="w-20 shrink-0 rounded-[4px]"
      />
      <div className="min-w-0">
        <p lang="zh-Hant" className="font-work-title text-xl font-semibold">
          {lantern.editions[1].title}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {words.store.edition}: <span lang="zh-Hant">{localeNames['zh-Hant']}</span> ·{' '}
          {words.store.translator}: <span lang="zh-Hant">{sale.translator}</span>
        </p>
      </div>
    </div>
  );
}

/** Price, tax and total: the whole sum before checkout. */
function Totals({ words }: Words) {
  const s = words.store;
  return (
    <dl className="grid gap-1.5 rounded-2xl border border-border bg-background p-4 text-sm tabular-nums">
      <div className="flex justify-between">
        <dt className="text-muted-foreground">{s.price}</dt>
        <dd>{sale.price}</dd>
      </div>
      <div className="flex justify-between">
        <dt className="text-muted-foreground">{s.tax}</dt>
        <dd>{sale.tax}</dd>
      </div>
      <div className="flex justify-between border-t border-border pt-2 text-base font-bold">
        <dt>{s.total}</dt>
        <dd>{sale.total}</dd>
      </div>
    </dl>
  );
}

/** Downloads a buyer keeps: open files and a game build, each with its own button. */
function Files({ words, arrive = 0 }: Words & { arrive?: number }) {
  const files = [
    { name: 'EPUB', icon: FileText },
    { name: 'PDF', icon: FileText },
    { name: 'Windows', icon: Gamepad2 },
  ];
  return (
    <ul className="flex flex-wrap gap-2">
      {files.map(({ name, icon: Icon }, index) => (
        <li
          key={name}
          data-arrive
          style={at(arrive + index * 5)}
          translate="no"
          className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm font-semibold"
        >
          <Icon aria-hidden className="size-4 text-primary" />
          {name}
          <Download aria-hidden className="size-4 text-muted-foreground" />
        </li>
      ))}
      <li className="flex items-center">
        <Badge variant="success" size="md">
          <Check aria-hidden />
          {words.store.noDrm}
        </Badge>
      </li>
    </ul>
  );
}

/* ---------- Hero ---------- */

/** One purchase in one picture: the edition and its full price, then the receipt and the files that stay. */
export function PurchaseHero({ words }: Words) {
  const s = words.store;
  return (
    <Plate className="flex flex-col gap-4">
      <EditionHeader words={words} />
      <Totals words={words} />
      <div data-arrive className="flex flex-wrap items-center justify-between gap-3">
        <span className={buttonVariants({ size: 'md' })}>{s.buy}</span>
        <Badge variant="success" size="md">
          <Receipt aria-hidden />
          {s.inLibrary}
        </Badge>
      </div>
      <div className="border-t border-border pt-4">
        <p className="mb-2.5 text-sm font-semibold text-muted-foreground">{s.files}</p>
        <Files words={words} arrive={8} />
      </div>
    </Plate>
  );
}

/* ---------- One purchase, one step at a time ---------- */

function Choose({ words }: Words) {
  return (
    <>
      <ul className="flex flex-col gap-2.5">
        {lantern.editions.map((edition, index) => (
          <li
            key={edition.lang}
            data-arrive
            style={at(index * 6)}
            className={cn(
              'flex items-center gap-3 rounded-2xl border p-3',
              edition.lang === 'zh-Hant'
                ? 'border-primary bg-accent'
                : 'border-border bg-background',
            )}
          >
            <WorkCover
              kind="book"
              id={lantern.id}
              title={edition.title}
              lang={edition.lang}
              className="w-10 shrink-0 rounded-[3px]"
            />
            <span className="min-w-0 flex-1">
              <span lang={edition.lang} className="block font-work-title font-semibold">
                {edition.title}
              </span>
              <span lang={edition.lang} className="block text-sm text-muted-foreground">
                {localeNames[edition.lang]}
              </span>
            </span>
            {edition.lang === 'zh-Hant' ? (
              <Check aria-hidden className="size-5 text-primary" />
            ) : null}
          </li>
        ))}
      </ul>
      <p className="flex items-center gap-2 text-sm">
        <UserRound aria-hidden className="size-4 text-primary" />
        {words.store.translator}: <span lang="zh-Hant">{sale.translator}</span>
      </p>
      <span className={buttonVariants({ variant: 'outline', size: 'sm', className: 'self-start' })}>
        <BookOpen aria-hidden />
        {words.store.sample}
      </span>
    </>
  );
}

function Buy({ words }: Words) {
  return (
    <>
      <EditionHeader words={words} />
      <div data-arrive>
        <Totals words={words} />
      </div>
      <span className={buttonVariants({ size: 'lg', className: 'self-start' })}>
        {words.store.buy} · {sale.total}
      </span>
    </>
  );
}

function Keep({ words }: Words) {
  const s = words.store;
  return (
    <>
      <p
        data-arrive
        className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-background p-3.5"
      >
        <span className="flex items-center gap-2 font-semibold">
          <Receipt aria-hidden className="size-4 text-primary" />
          {s.receipt}
        </span>
        <Badge variant="success" size="md">
          <Check aria-hidden />
          {s.inLibrary}
        </Badge>
      </p>
      <Files words={words} arrive={6} />
      <p className="text-sm text-muted-foreground">{s.downloadAgain}</p>
    </>
  );
}

function Update({ words }: Words) {
  const s = words.store;
  const versions = [
    { n: '1.4', note: s.patched, latest: true },
    { n: '1.3', note: s.corrected, latest: false },
    { n: '1.2', note: null, latest: false },
  ] as const;
  return (
    <>
      <p lang="en" className="flex items-center gap-3 font-work-title text-lg font-semibold">
        <WorkCover
          kind="package"
          id={glassTide.id}
          title={glassTide.title}
          lang="en"
          className="w-12 shrink-0"
        />
        {glassTide.title}
      </p>
      <ul className="flex flex-col gap-2">
        {versions.map((version, index) => (
          <li
            key={version.n}
            data-arrive
            style={at(index * 6)}
            className={cn(row, version.latest && 'border-primary bg-accent')}
          >
            <span className="font-semibold">{fill(s.version, { n: version.n })}</span>
            <span className="flex items-center gap-2 text-muted-foreground">
              {version.note}
              {version.latest ? (
                <Badge variant="soft" size="sm">
                  {words.desk.latest}
                </Badge>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">{s.earlierKept}</p>
    </>
  );
}

export type StoreStage = 'choose' | 'buy' | 'keep' | 'update';

/** One purchase from choosing the edition to updating it years later, a stage at a time. */
export function StoreFlow({ words, stage }: Words & { stage: StoreStage }) {
  return (
    <Plate className="flex flex-col gap-4">
      {stage === 'choose' ? <Choose words={words} /> : null}
      {stage === 'buy' ? <Buy words={words} /> : null}
      {stage === 'keep' ? <Keep words={words} /> : null}
      {stage === 'update' ? <Update words={words} /> : null}
    </Plate>
  );
}

/* ---------- Showcase vignettes ---------- */

function Statements({ words }: Words) {
  const s = words.store;
  const lines = [
    { name: s.sales, amount: '€1,240.00' },
    { name: s.tax, amount: '−€237.61' },
    { name: s.paymentFees, amount: '−€39.10' },
    { name: s.refunds, amount: '−€11.90' },
    { name: s.payout, amount: '€951.39', total: true },
  ] as const;
  return (
    <dl className="grid w-full max-w-xs gap-1.5 text-sm tabular-nums">
      {lines.map((line) => (
        <div
          key={line.name}
          className={cn(
            'flex justify-between',
            'total' in line && 'border-t border-border pt-1.5 font-bold',
          )}
        >
          <dt className={'total' in line ? '' : 'text-muted-foreground'}>{line.name}</dt>
          <dd>{line.amount}</dd>
        </div>
      ))}
    </dl>
  );
}

function Rights({ words }: Words) {
  const s = words.store;
  return (
    <dl className="grid w-full max-w-xs gap-2 text-sm">
      <div className={row}>
        <dt className="text-muted-foreground">{s.madeBy}</dt>
        <dd lang="ja">{lantern.author.ja}</dd>
      </div>
      <div className={row}>
        <dt className="text-muted-foreground">{s.translator}</dt>
        <dd lang="zh-Hant">{sale.translator}</dd>
      </div>
      <div className="rounded-xl border border-border bg-background px-3 py-2">
        <dt className="text-muted-foreground">{s.readersMay}</dt>
        <dd>{s.readersMayDo}</dd>
      </div>
    </dl>
  );
}

function Connected({ words }: Words) {
  const tabs = [words.store.store, words.realm.name, words.community.knowledge];
  return (
    <div className="flex w-full max-w-sm flex-col gap-3">
      <ul className="flex flex-wrap gap-1.5">
        {tabs.map((tab, index) => (
          <li
            key={tab}
            lang={index === 1 ? 'en' : undefined}
            className={cn(
              'rounded-full px-3 py-1 text-sm font-semibold',
              index === 0 ? 'bg-(--cloth-ink) text-(--cloth)' : 'border border-current opacity-75',
            )}
          >
            {tab}
          </li>
        ))}
      </ul>
      <p className="flex items-center gap-3">
        <WorkCover
          kind="book"
          id={lantern.id}
          title={lantern.editions[2].title}
          lang="en"
          authors={[lantern.author.en]}
          className="w-16 shrink-0 rounded-[3px]"
        />
        <span lang="en" className="font-work-title text-lg font-semibold">
          {lantern.editions[2].title}
        </span>
      </p>
    </div>
  );
}

function Creators({ words }: Words) {
  const s = words.store;
  return (
    <div className="flex w-full max-w-sm flex-col gap-3">
      <p className="flex items-center justify-between gap-3">
        <span lang="en" className="font-semibold">
          {saltMarsh.author}
        </span>
        <Badge variant="soft" size="md">
          {s.follow}
        </Badge>
      </p>
      <ul className="flex items-end gap-3">
        <li className="flex flex-col items-center gap-1.5 text-sm text-muted-foreground">
          <WorkCover
            kind="book"
            id={shelf[1].id}
            title={shelf[1].title}
            lang="en"
            className="w-20 rounded-[4px]"
          />
          {s.book}
        </li>
        <li className="flex flex-col items-center gap-1.5 text-sm text-muted-foreground">
          <WorkCover
            kind="package"
            id={glassTide.id}
            title={glassTide.title}
            lang="en"
            className="w-20"
          />
          {s.game}
        </li>
      </ul>
    </div>
  );
}

export const distributionVignettes: Record<string, Picture> = {
  statements: Statements,
  rights: Rights,
  connected: Connected,
  creators: Creators,
};
