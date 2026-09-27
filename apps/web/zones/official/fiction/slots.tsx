import { Tabs, TabsContent, TabsList, TabsTrigger } from '@rezics/ui/tabs';
import type { HeaderSlotProps, HeroSlotProps, ModuleSlotProps, RankingInterval, ZoneSlotProps } from '@rezics/zone-sdk';
import { strings } from './strings.ts';

// Slots of the official Fiction Zone. They render only data the platform
// passes in and keep the platform's controls (`actions`) and cards (`card`),
// which carry each pick's "Why here?" stamp.

const intervalLabels: Record<string, Record<RankingInterval, string>> = {
  en: { day: 'Today', week: 'This week', month: 'This month' },
  'zh-Hans': { day: '日榜', week: '周榜', month: '月榜' },
  'zh-Hant': { day: '日榜', week: '週榜', month: '月榜' },
};

/** The masthead: the Zone's seal and wordmark on manuscript paper. */
export function FictionHeader({ zone, actions, members }: HeaderSlotProps) {
  const t = strings(zone.locale);
  return <header className="fz-masthead">
    <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-5 gap-y-4 px-4 py-7 sm:px-6 sm:py-9
      lg:px-10">
      <span aria-hidden="true" className="fz-seal">文</span>
      <div className="min-w-0 flex-1 basis-64">
        <p className="fz-kicker">{t.official}</p>
        <h1 lang={zone.name.lang} className="fz-wordmark">{zone.name.value}</h1>
        <p className="fz-tagline">{zone.description?.value ?? t.tagline}</p>
        {members ? <p className="fz-members">{members}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  </header>;
}

/** The hero keeps the platform carousel and sets it on a band of the Zone's paper. */
export function FictionHero({ fallback }: HeroSlotProps) {
  return <div className="fz-hero">{fallback}</div>;
}

/** Rankings as a chart: a podium for the top three, then a numbered list. */
export function FictionRanking({ zone, module, data, card }: ModuleSlotProps<'ranking'>) {
  const t = strings(zone.locale);
  const labels = intervalLabels[zone.locale] ?? intervalLabels.en!;
  const tabs = data.tabs.filter(tab => tab.items.length);
  const heading = `fz-ranking-${module.id}`;
  return <section aria-labelledby={heading} data-zone-module="ranking" className="zone-module fz-ranking">
    <header className="mb-2 flex items-center justify-between gap-3">
      <h2 id={heading} className="fz-module-title">{module.title}</h2>
      {module.more ? <a href={module.more} className="fz-more">{t.more}</a> : null}
    </header>
    <Tabs defaultValue={tabs[0]?.interval} className="gap-4">
      <TabsList variant="underline" aria-label={module.title} className="justify-start">
        {tabs.map(tab => <TabsTrigger key={tab.interval} value={tab.interval} className="grow-0 px-4">
          {labels[tab.interval]}</TabsTrigger>)}
      </TabsList>
      {tabs.map(tab => <TabsContent key={tab.interval} value={tab.interval} className="grid grid-cols-1 gap-5">
        <ol aria-label={t.podium} className="fz-podium">
          {tab.items.slice(0, 3).map(item => <li key={item.work.id} data-rank={item.rank} className="fz-podium-place">
            {card(item.work)}</li>)}
        </ol>
        {tab.items.length > 3 ? <ol start={4} className="fz-chart">
          {tab.items.slice(3, 10).map(item => <li key={item.work.id}>
            {card(item.work, { layout: 'row', rank: item.rank })}</li>)}
        </ol> : null}
      </TabsContent>)}
    </Tabs>
  </section>;
}

/** A closing band on dark slate: what this Zone is, and where its decisions are. */
export function FictionFooter({ zone }: ZoneSlotProps) {
  const t = strings(zone.locale);
  return <footer className="fz-footer">
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-9 sm:flex-row sm:items-center sm:px-6 lg:px-10">
      <span aria-hidden="true" className="fz-seal fz-seal-small">文</span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-semibold">{t.footerTitle}</p>
        <p className="max-w-xl text-pretty text-sm opacity-80">{t.footerNote}</p>
      </div>
      <nav aria-label={t.footerTitle}>
        <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <li><a href={zone.links.works}>{t.works}</a></li>
          <li><a href={zone.links.decisions}>{t.decisions}</a></li>
          <li><a href={zone.links.about}>{t.about}</a></li>
        </ul>
      </nav>
    </div>
  </footer>;
}
