import { Badge } from '@rezics/ui/badge';
import { Button, buttonVariants } from '@rezics/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@rezics/ui/card';
import { Input } from '@rezics/ui/input';
import { ArrowRightIcon, CompassIcon, LibraryBigIcon, type LucideIcon, PenLineIcon, SearchIcon,
  UsersRoundIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PageContainer } from '../shell/page.tsx';
import type { HomeMessages } from './messages.ts';

interface HomeSection {
  icon: LucideIcon;
  title: string;
  body: string;
  /** A live destination; a section without one is still to come and says so. */
  action?: { href: string; label: string };
}

function sections(messages: HomeMessages): HomeSection[] {
  return [
    { icon: CompassIcon, title: messages.discoverTitle, body: messages.discoverBody,
      action: { href: '/discover', label: messages.discoverAction } },
    { icon: PenLineIcon, title: messages.createTitle, body: messages.createBody,
      action: { href: '/studio', label: messages.createAction } },
    { icon: LibraryBigIcon, title: messages.readingTitle, body: messages.readingBody },
    { icon: UsersRoundIcon, title: messages.realmsTitle, body: messages.realmsBody },
  ];
}

/**
 * The landing page: search first, then a scoped discovery shelf when the
 * route supplies one, then what REZICS offers now and what is coming.
 */
export function HomePage({ messages, shelf }: { messages: HomeMessages; shelf?: ReactNode }) {
  return <PageContainer className="grid gap-10">
    <section aria-labelledby="home-title" className="aura-surface rounded-3xl border border-border/60 px-6 py-10
      shadow-(--aura-shadow-card) sm:px-10 sm:py-14 lg:px-14 lg:py-20">
      <h1 id="home-title" className="max-w-3xl text-balance font-semibold text-4xl tracking-tight sm:text-5xl">
        {messages.title}</h1>
      <p className="mt-4 max-w-2xl text-pretty text-lg text-muted-foreground">{messages.description}</p>
      <form role="search" aria-label={messages.searchLabel} action="/search" method="get"
        className="mt-8 flex max-w-2xl flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <SearchIcon aria-hidden="true" className="pointer-events-none absolute start-4 top-1/2 size-5 -translate-y-1/2
            text-muted-foreground" />
          <Input name="q" type="search" required minLength={2} maxLength={80} aria-label={messages.searchLabel}
            placeholder={messages.searchPlaceholder} className="h-12 rounded-2xl bg-card ps-12 text-base md:text-base" />
        </div>
        <Button type="submit" size="xl">{messages.search}</Button>
      </form>
    </section>
    {shelf}
    <section aria-labelledby="home-sections" className="grid gap-4">
      <h2 id="home-sections" className="sr-only">{messages.sections}</h2>
      <ul className="grid gap-4 sm:grid-cols-2">
        {sections(messages).map(section => <li key={section.title} className="grid">
          <Card className="h-full">
            <CardHeader className="gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
                <section.icon aria-hidden="true" className="size-5" /></span>
              <CardTitle asChild><h3>{section.title}</h3></CardTitle>
            </CardHeader>
            <CardContent className="flex-1 text-muted-foreground text-sm">{section.body}</CardContent>
            <CardFooter className="border-0 bg-transparent pt-0">
              {section.action
                ? <Link href={section.action.href} className={buttonVariants({ variant: 'soft', size: 'sm' })}>
                  {section.action.label}<ArrowRightIcon aria-hidden="true" /></Link>
                : <Badge variant="secondary" size="lg">{messages.comingSoon}</Badge>}
            </CardFooter>
          </Card>
        </li>)}
      </ul>
    </section>
  </PageContainer>;
}
