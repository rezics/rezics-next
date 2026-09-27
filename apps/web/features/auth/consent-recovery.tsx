import { Card, CardContent } from '@rezics/ui/card';
import { signInPath } from './paths.ts';
import type { AuthMessages } from './messages.ts';
import { PageContainer } from '../shell/page.tsx';
import LocalizedLink from '../shell/localized-link.tsx';

export function ConsentRecovery({ next, messages }: { next: string; messages: AuthMessages }) {
  return <PageContainer className="max-w-xl py-8 sm:py-16">
    <Card><CardContent className="grid gap-5 p-6 sm:p-8">
      <h1 className="font-semibold text-2xl">{messages.consentHeading}</h1>
      <p>{messages.consentDeclined}</p>
      <LocalizedLink href={signInPath(next)}
        className="justify-self-start rounded-xl bg-primary px-5 py-2 font-medium text-primary-foreground">
        {messages.signInAgain}</LocalizedLink>
    </CardContent></Card>
  </PageContainer>;
}
