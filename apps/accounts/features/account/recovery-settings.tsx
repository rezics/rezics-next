'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Checkbox } from '@rezics/ui/checkbox';
import { Field, FieldContent, FieldError, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { useFormValue } from '@rezics/ui/form-value';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { SectionHeading, SettingsCard } from './account-shell.tsx';
import { failureText } from './failure-text.ts';
import { useStepUp } from './step-up.tsx';
import { useAccountClient } from '../api/account-client.tsx';
import type { GuardianPage, RecoveryPolicyView } from '../api/recovery-policy.ts';
import type { Read } from '../api/server.ts';
import { EmailField, emailPattern, PasswordField } from '../auth/fields.tsx';
import { ReadStatePanel } from '../shell/state-panel.tsx';
import { useLocale, useTranslation } from '../../i18n/client.ts';

/** Browser CSPRNG; only the hash crosses Account storage. Never put this code
 * into a URL, a log or persistent browser storage. Keep it for uncertain retries. */
function newRecoveryCode() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function RecoverySetup({
  policy,
  hasPassword,
  onCodeVisible,
}: {
  policy: RecoveryPolicyView['policy'];
  hasPassword: boolean;
  onCodeVisible(visible: boolean): void;
}) {
  const { t } = useTranslation('account');
  const copy = t.recovery;
  const common = useTranslation('common').t;
  const auth = useTranslation('auth').t;
  const { api, refresh, download } = useAccountClient();
  const stepUp = useStepUp();
  const proposal = useRef<string | undefined>(undefined);
  const [email, setEmail] = useState(policy?.guardianEmail ?? '');
  const [password, setPassword] = useState('');
  const [previous, setPrevious] = useState('');
  const [failure, setFailure] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string; previous?: string }>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const previousInput = useFormValue(previous, setPrevious);
  useEffect(() => {
    setInteractive(true);
  }, []);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const found = {
      email: !email.trim()
        ? auth.emailRequired
        : !emailPattern.test(email.trim())
          ? auth.emailInvalid
          : undefined,
      password: hasPassword && !password ? t.currentPasswordRequired : undefined,
      previous:
        policy?.hasCode && !/^[A-Za-z0-9_-]{43}$/.test(previous.trim())
          ? common.refusalCode
          : undefined,
    };
    setErrors(found);
    setFailure('');
    if (Object.values(found).some(Boolean)) return;
    proposal.current ??= newRecoveryCode();
    const recoveryCode = proposal.current;
    setBusy(true);
    const run = () =>
      api.enrollRecovery({
        guardianEmail: email.trim(),
        recoveryCode,
        ...(hasPassword ? { currentPassword: password } : {}),
        ...(policy?.hasCode ? { previousRecoveryCode: previous.trim() } : {}),
      });
    const result = hasPassword ? await run() : await stepUp(run);
    setBusy(false);
    if (result.ok) {
      setShown(recoveryCode);
      onCodeVisible(true);
      setCompleted(true);
      setUncertain(false);
      setPassword('');
      setPrevious('');
      // Keep the one-time code in view until it is saved. An immediate server
      // refresh could replace the page if the session has just expired.
    } else if (result.kind === 'unavailable') {
      setShown(recoveryCode);
      onCodeVisible(true);
      setUncertain(true);
    } else {
      if (result.kind === 'cancelled') return;
      if (result.kind === 'invalid-credentials')
        setErrors((current) => ({ ...current, password: t.wrongCurrentPassword }));
      else setFailure(failureText(result.kind, common));
    }
  }

  return (
    <div className="space-y-5 px-5 py-5 sm:px-6">
      {shown ? (
        <section aria-label={copy.newCode} className="space-y-4">
          <p className="break-all text-sm">
            {copy.guardianEmail}: <bdi>{email.trim()}</bdi>
          </p>
          <Field>
            <FieldLabel>{copy.newCode}</FieldLabel>
            <Input readOnly autoComplete="off" className="font-mono" value={shown} />
          </Field>
          <p className="text-sm text-muted-foreground">{copy.save}</p>
          {uncertain ? (
            <Alert role="alert">
              <AlertDescription>{copy.uncertain}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard
                  .writeText(shown)
                  .then(() => setCopied(true))
                  .catch(() => setFailure(common.refusalFailed));
              }}
            >
              {copied ? copy.copied : copy.copy}
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                download(
                  new Blob([`${shown}\n`], { type: 'text/plain' }),
                  'rezics-recovery-code.txt',
                )
              }
            >
              {copy.download}
            </Button>
            {uncertain ? (
              <Button disabled={busy} isLoading={busy} onClick={() => void submit()}>
                {copy.retry}
              </Button>
            ) : null}
          </div>
          {completed ? (
            <>
              <Field orientation="horizontal">
                <Checkbox
                  checked={saved}
                  onCheckedChange={({ checked }) => setSaved(checked === true)}
                />
                <FieldContent>
                  <FieldLabel>{copy.saved}</FieldLabel>
                </FieldContent>
              </Field>
              <Button
                disabled={!saved}
                onClick={() => {
                  setShown('');
                  setCompleted(false);
                  setSaved(false);
                  setCopied(false);
                  proposal.current = undefined;
                  onCodeVisible(false);
                  refresh();
                }}
              >
                {copy.done}
              </Button>
            </>
          ) : null}
        </section>
      ) : null}
      {!completed ? (
        <form
          method="post"
          noValidate
          onSubmit={(event) => void submit(event)}
          className="space-y-4"
        >
          <EmailField
            label={copy.guardianEmail}
            value={email}
            error={errors.email}
            autoComplete="off"
            disabled={busy || uncertain}
            onChange={(value) => {
              setEmail(value);
              proposal.current = undefined;
              setErrors({});
            }}
          />
          {policy?.hasCode ? (
            <>
              <p className="text-sm text-muted-foreground">{copy.renewWarning}</p>
              <Field invalid={!!errors.previous} disabled={busy || uncertain}>
                <FieldLabel>{copy.currentCode}</FieldLabel>
                <Input
                  autoComplete="off"
                  className="font-mono"
                  {...previousInput}
                  disabled={busy || uncertain}
                  onChange={(event) => {
                    setPrevious(event.currentTarget.value);
                    setErrors({});
                  }}
                />
                <FieldError>{errors.previous}</FieldError>
              </Field>
            </>
          ) : null}
          {hasPassword ? (
            <>
              <input type="text" name="username" autoComplete="username" hidden readOnly />
              <PasswordField
                label={t.currentPassword}
                name="current-password"
                value={password}
                error={errors.password}
                autoComplete="current-password"
                visibilityLabel={auth.showPassword}
                disabled={busy || uncertain}
                onChange={(value) => {
                  setPassword(value);
                  setErrors({});
                }}
              />
            </>
          ) : null}
          <Button
            type="submit"
            size="lg"
            isLoading={busy}
            disabled={!interactive || busy || uncertain}
            className="h-auto min-h-11 whitespace-normal"
          >
            {policy?.hasCode ? copy.renew : copy.setup}
          </Button>
        </form>
      ) : null}
      {failure ? (
        <Alert role="alert" variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

/** UI follows server-owned membership and transitions; it never infers an
 * Account from a mailbox or creates an implicit guardian. */
export function RecoverySettings({
  recovery,
  invitations,
  hasPassword = true,
  emailVerified = true,
}: {
  recovery: Read<RecoveryPolicyView>;
  invitations: Read<GuardianPage>;
  hasPassword?: boolean;
  emailVerified?: boolean;
}) {
  const { t } = useTranslation('account');
  const copy = t.recovery;
  const common = useTranslation('common').t;
  const locale = useLocale().current;
  const { api, refresh } = useAccountClient();
  const initial = invitations.status === 'ok' ? invitations.data : { items: [], nextCursor: null };
  const [page, setPage] = useState(initial);
  const [incomingFirst] = useState(initial.items.length > 0);
  useEffect(() => {
    if (invitations.status === 'ok') setPage(invitations.data);
  }, [invitations]);
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const [codeVisible, setCodeVisible] = useState(false);
  const date = (value: string) =>
    // Server and browser may use different zones; make the deadline explicit
    // and stable during hydration, rather than shifting its calendar day.
    new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
      timeZoneName: 'short',
    }).format(new Date(value));
  async function change(id: string, action: 'accept' | 'decline' | 'withdraw') {
    setBusy(id);
    setFailure('');
    setNotice('');
    const result = await api.changeGuardian(id, action);
    setBusy('');
    if (!result.ok) {
      setFailure(failureText(result.kind, common));
      if (!codeVisible) refresh();
      return;
    }
    setPage((current) => ({
      ...current,
      items:
        action === 'accept'
          ? current.items.map((item) =>
              item.invitationId === id ? { ...item, state: 'accepted' } : item,
            )
          : current.items.filter((item) => item.invitationId !== id),
    }));
    setNotice(
      action === 'accept' ? copy.accepted : action === 'decline' ? copy.declined : copy.withdrawn,
    );
    if (!codeVisible) refresh();
  }
  async function more() {
    if (!page.nextCursor) return;
    setBusy('more');
    setFailure('');
    const result = await api.readGuardianInvitations(page.nextCursor);
    setBusy('');
    if (!result.ok) return setFailure(failureText(result.kind, common));
    setPage((current) => ({
      items: [
        ...current.items,
        ...result.data.items.filter(
          (item) => !current.items.some((prior) => prior.invitationId === item.invitationId),
        ),
      ],
      nextCursor: result.data.nextCursor,
    }));
  }
  const policy = recovery.status === 'ok' ? recovery.data.policy : null;
  const ownerCard = (
    <SettingsCard key="owner" title={copy.ownerTitle}>
      {recovery.status === 'ok' ? (
        <>
          {!codeVisible ? (
            <div className="space-y-2 border-b border-border/60 px-5 py-4 sm:px-6">
              <p className="font-medium">{policy ? copy.states[policy.state] : copy.notSet}</p>
              {policy ? (
                <p className="break-all text-sm">
                  <bdi>{policy.guardianEmail}</bdi>
                </p>
              ) : null}
              {policy?.state === 'pending' ? (
                <p className="text-sm text-muted-foreground">{copy.pendingNote}</p>
              ) : null}
              {policy?.state === 'pending' || policy?.state === 'expired' ? (
                <p className="text-sm text-muted-foreground">
                  {copy.expires}: {date(policy.expiresAt)}
                </p>
              ) : null}
            </div>
          ) : null}
          <RecoverySetup policy={policy} hasPassword={hasPassword} onCodeVisible={setCodeVisible} />
        </>
      ) : (
        <ReadStatePanel status={recovery.status} next="/security/recovery" />
      )}
    </SettingsCard>
  );
  const invitationsCard = (
    <SettingsCard key="invitations" title={copy.invitationsTitle}>
      {invitations.status === 'ok' ? (
        <div className="space-y-4 px-5 py-5 sm:px-6">
          {!emailVerified ? <p className="text-sm text-muted-foreground">{copy.verify}</p> : null}
          {notice ? (
            <Alert role="status" variant="success">
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          ) : null}
          {failure ? (
            <Alert role="alert" variant="destructive">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          ) : null}
          {!page.items.length ? <p className="text-muted-foreground">{copy.empty}</p> : null}
          {page.items.map((item) => (
            <section
              key={item.invitationId}
              aria-label={item.ownerEmail}
              className="space-y-3 rounded-2xl border border-border/60 p-4"
            >
              <h3 className="break-all font-medium">
                <bdi>{item.ownerEmail}</bdi>
              </h3>
              <p className="text-sm font-medium">{copy.states[item.state]}</p>
              <p className="text-sm text-muted-foreground">
                {item.state === 'pending' ? copy.consent : copy.withdrawal}
              </p>
              {item.state === 'pending' ? (
                <p className="text-sm text-muted-foreground">
                  {copy.expires}: {date(item.expiresAt)}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {item.state === 'pending' ? (
                  <>
                    <Button
                      disabled={!!busy}
                      onClick={() => void change(item.invitationId, 'accept')}
                    >
                      {copy.accept}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={!!busy}
                      onClick={() => void change(item.invitationId, 'decline')}
                    >
                      {copy.decline}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => void change(item.invitationId, 'withdraw')}
                  >
                    {copy.withdraw}
                  </Button>
                )}
              </div>
            </section>
          ))}
          {page.nextCursor ? (
            <Button
              variant="outline"
              disabled={!!busy}
              isLoading={busy === 'more'}
              onClick={() => void more()}
            >
              {copy.more}
            </Button>
          ) : null}
        </div>
      ) : (
        <ReadStatePanel status={invitations.status} next="/security/recovery" />
      )}
    </SettingsCard>
  );
  return (
    <>
      <SectionHeading
        title={copy.title}
        intro={copy.intro}
        back={{ href: '/security', label: t.security }}
      />
      <div className="space-y-6">
        {incomingFirst ? [invitationsCard, ownerCard] : [ownerCard, invitationsCard]}
      </div>
    </>
  );
}
