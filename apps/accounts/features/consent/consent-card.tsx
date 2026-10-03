'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import {
  AppWindowIcon,
  BookOpenIcon,
  InfinityIcon,
  KeyRoundIcon,
  UserRoundIcon,
} from 'lucide-react';
import { type FormEvent, useActionState, useState } from 'react';
import { useAccountClient } from '../api/account-client.tsx';
import type { FailureKind } from '../api/errors.ts';
import { failureText } from '../account/failure-text.ts';
import { acceptanceAfterSignIn } from '../auth/policies.ts';
import { groupScopes, type ScopeGroup } from './scopes.ts';
import { type AvatarUser, UserAvatar } from '../shell/user-avatar.tsx';
import { useTranslation } from '../../i18n/client.ts';
import { unchangedForm, type AuthFormAction } from '../auth/form-state.ts';
import { useFormResponse } from '../auth/form-response.ts';

export interface ConsentApp {
  name: string | null;
  logo: string | null;
  uri: string | null;
  policy: string | null;
  terms: string | null;
  unverified?: boolean;
  redirectHost?: string | null;
}

const groupIcons: Record<ScopeGroup, typeof UserRoundIcon> = {
  identity: UserRoundIcon,
  works: BookOpenIcon,
  other: KeyRoundIcon,
  offline: InfinityIcon,
};
const groupTitles = {
  identity: 'groupIdentity',
  works: 'groupWorks',
  other: 'groupOther',
  offline: 'groupOffline',
} as const;

/** The OAuth consent step: who is asking, as which account, for what. */
export function ConsentCard({
  app,
  user,
  scopes,
  oauthQuery,
  descriptions,
  action,
}: {
  app: ConsentApp | null;
  user: AvatarUser;
  scopes: string[];
  oauthQuery: string;
  descriptions?: Readonly<Record<string, string>>;
  action?: AuthFormAction;
}) {
  const { t } = useTranslation('consent');
  const common = useTranslation('common').t;
  const { api, navigate } = useAccountClient();
  const [busy, setBusy] = useState<'allow' | 'deny' | 'switch'>();
  const [native, submitNative] = useActionState(action ?? unchangedForm, {});
  const [failure, setFailure] = useState<FailureKind | undefined>(
    native.failure === 'challenge-unavailable' ? undefined : native.failure,
  );
  useFormResponse(native, (state) =>
    setFailure(state.failure === 'challenge-unavailable' ? undefined : state.failure),
  );
  const name = app?.name?.trim() || t.unknownApp;
  const unverified = app?.unverified !== false;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const button = (event.nativeEvent as SubmitEvent).submitter;
    if (!(button instanceof HTMLButtonElement)) return;
    if (button.value === 'switch') void switchAccount();
    else void answer(button.value === 'allow');
  }

  async function answer(accept: boolean) {
    setBusy(accept ? 'allow' : 'deny');
    setFailure(undefined);
    const result = await api.consent(accept, oauthQuery);
    if (result.ok) return navigate(result.data.redirect);
    setBusy(undefined);
    if (result.kind === 'policy-acceptance-required')
      return navigate(acceptanceAfterSignIn(oauthQuery, '/', oauthQuery));
    setFailure(result.kind);
  }

  async function switchAccount() {
    setBusy('switch');
    const result = await api.signOut();
    if (!result.ok && result.kind !== 'unauthenticated') {
      setBusy(undefined);
      setFailure(result.kind);
      return;
    }
    // The signed request stays valid for the next account until it expires.
    navigate(`/sign-in?${oauthQuery}`);
  }

  return (
    <form
      action={action ? submitNative : undefined}
      onSubmit={submit}
      className="flex flex-col gap-6"
    >
      <input type="hidden" name="operation" value="consent" />
      <header className="flex flex-col gap-4">
        <span className="grid size-14 place-items-center overflow-hidden rounded-2xl border border-border/60 bg-accent text-accent-foreground">
          {!unverified && app?.logo ? (
            <img src={app.logo} alt="" className="size-full object-cover" />
          ) : (
            <AppWindowIcon className="size-7" aria-hidden="true" />
          )}
        </span>
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight">
          {t.title({ app: name })}
        </h1>
        {unverified ? (
          <div className="flex flex-col items-start gap-2">
            <Badge variant="warning">{t.unverifiedApp}</Badge>
            <p className="text-sm text-muted-foreground">{t.unverifiedIdentity}</p>
          </div>
        ) : null}
        {app?.redirectHost ? (
          <p className="text-sm text-muted-foreground">
            {t.redirectHost}{' '}
            <bdi className="break-all font-medium text-foreground">{app.redirectHost}</bdi>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-border/80 py-1 ps-1 pe-3 text-sm">
            <UserAvatar user={user} size="sm" />
            <span className="sr-only">{t.signedInAs} </span>
            <span className="truncate font-medium">{user.email}</span>
          </span>
          <Button
            type="submit"
            name="decision"
            value="switch"
            variant="link"
            size="sm"
            className="px-0"
            disabled={!!busy}
          >
            {t.switchAccount}
          </Button>
        </div>
      </header>
      <section aria-labelledby="consent-scopes">
        <h2 id="consent-scopes" className="mb-3 font-medium">
          {t.allowIntro({ app: name })}
        </h2>
        <ul className="flex flex-col divide-y divide-border/60 rounded-2xl border border-border/60">
          {groupScopes(scopes).map(({ group, lines }) => {
            const Icon = groupIcons[group];
            return (
              <li key={group} className="flex gap-3 px-4 py-3.5">
                <Icon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
                <div className="min-w-0">
                  <h3 className="font-medium">{t[groupTitles[group]]}</h3>
                  <ul className="mt-1 flex flex-col gap-1 text-sm text-muted-foreground">
                    {lines.map((line) => (
                      <li key={line.scope}>
                        {line.message
                          ? t[line.message]
                          : (descriptions?.[line.scope] ?? (
                              <>
                                {t.scopeOtherPrefix}{' '}
                                <code className="font-mono text-foreground">{line.scope}</code>
                              </>
                            ))}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      <p className="text-sm text-muted-foreground">
        {t.trust({ app: name })}
        {!unverified && (app?.policy || app?.terms) ? (
          <span className="mt-1 flex gap-4">
            {app.policy ? (
              <a
                className="text-primary underline-offset-4 hover:underline"
                href={app.policy}
                target="_blank"
                rel="noreferrer"
              >
                {t.appPolicy}
              </a>
            ) : null}
            {app.terms ? (
              <a
                className="text-primary underline-offset-4 hover:underline"
                href={app.terms}
                target="_blank"
                rel="noreferrer"
              >
                {t.appTerms}
              </a>
            ) : null}
          </span>
        ) : null}
      </p>
      {failure ? (
        <Alert role="alert" variant="destructive">
          <AlertDescription>
            {failure === 'expired-request'
              ? t.expired
              : failure === 'unauthenticated'
                ? t.signedOutBody
                : failure === 'unavailable'
                  ? t.unavailable
                  : failureText(failure, common)}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap justify-end gap-3">
        <Button
          type="submit"
          name="decision"
          value="deny"
          variant="outline"
          size="lg"
          disabled={!!busy}
          isLoading={busy === 'deny'}
        >
          {t.deny}
        </Button>
        <Button
          type="submit"
          name="decision"
          value="allow"
          size="lg"
          disabled={!!busy}
          isLoading={busy === 'allow'}
        >
          {busy === 'allow' ? t.working : t.allow}
        </Button>
      </div>
    </form>
  );
}
