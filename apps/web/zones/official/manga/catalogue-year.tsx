import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import type { BrowseHeaderSlotProps } from '@rezics/zone-sdk';

// The publication-year control, in the same row as Filters: one bordered bar,
// the same height, padding and gap, so it sits with search instead of as its own form.

type Year = NonNullable<BrowseHeaderSlotProps['year']>;

export function CatalogueYearForm({ year, label, submit, clear, directory, bounded, Link }: {
  year: Year;
  label: string;
  submit: string;
  clear: string;
  directory: string;
  bounded: string;
  Link: BrowseHeaderSlotProps['Link'];
}) {
  return <form action={year.action} method="get" data-catalogue-year=""
    className="flex min-h-11 flex-wrap items-center gap-2 rounded-xl border border-border/80 bg-card px-4 py-1.5 text-sm">
    {year.kept.map(item => <input key={`${item.name}=${item.value}`} type="hidden" name={item.name} value={item.value} />)}
    <label className="flex items-center gap-2 font-medium">{label}
      <input name="year" defaultValue={year.value} autoComplete="off"
        pattern="[1-9][0-9]{0,3}(-[1-9][0-9]{0,3})?" placeholder="2000-2009"
        className="h-8 w-32 rounded-xl border border-border/80 bg-card px-3 font-normal text-foreground text-sm outline-none hover:border-border focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20" />
    </label>
    <button type="submit" className={buttonVariants({ size: 'sm' })}>{submit}</button>
    {year.clearHref ? <Link href={year.clearHref}
      className={cn(buttonVariants({ variant: 'link', size: 'sm' }), 'px-1')}>{clear}</Link> : null}
    {year.directory ? null : <Link href={year.directoryHref}
      className={cn(buttonVariants({ variant: 'link', size: 'sm' }), 'px-1')}>{directory}</Link>}
    {year.bounded ? <p className="basis-full font-normal text-muted-foreground">{bounded}</p> : null}
  </form>;
}
