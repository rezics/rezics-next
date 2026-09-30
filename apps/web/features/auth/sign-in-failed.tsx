import { Card, CardContent } from '@rezics/ui/card';
import { formatMessage, type AuthMessages } from './messages.ts';
import { type SignInFailure, signInPath } from './paths.ts';
import { PageContainer } from '../shell/page.tsx';
import LocalizedLink from '../shell/localized-link.tsx';

function reasonText(reason: SignInFailure, messages: AuthMessages): string {
  switch (reason) {
    case 'state': return messages.failedState;
    case 'issuer': return messages.failedIssuer;
    case 'code': return messages.failedCode;
    case 'exchange': return messages.failedExchange;
    case 'config': return messages.failedConfig;
    case 'session': return messages.failedSession;
    case 'provider': return messages.failedProvider;
    case 'unknown': return messages.failedUnknown;
  }
}

/** The callback's failure page: what failed, in the person's language, and a retry. */
export function SignInFailed({ reason, providerCode, next, messages }: {
  reason: SignInFailure; providerCode: string | null; next: string; messages: AuthMessages;
}) {
  return <PageContainer className="max-w-xl py-8 sm:py-16">
    <Card><CardContent className="grid gap-5 p-6 sm:p-8">
      <h1 className="font-semibold text-2xl">{messages.signInFailedHeading}</h1>
      <p role="alert">{reasonText(reason, messages)}</p>
      {providerCode ? <p className="text-muted-foreground text-sm">
        <code>{formatMessage(messages.providerCode, { code: providerCode })}</code></p> : null}
      <LocalizedLink href={signInPath(next)}
        className="justify-self-start rounded-xl bg-primary px-5 py-2 font-medium text-primary-foreground">
        {messages.signInAgain}</LocalizedLink>
    </CardContent></Card>
  </PageContainer>;
}
