import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { type AgentOption, agentName } from './acting-identity.ts';
import { type AuthMessages, formatMessage } from './messages.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import LocalizedLink from '../shell/localized-link.tsx';

export type AgentPickerNotice =
  | { kind: 'ineligible'; previous: string }
  | { kind: 'ineligible-default'; previous: string }
  | { kind: 'invalid' | 'stale-session' | 'stale-default' | 'default-not-saved' | 'unavailable' };

export interface AgentPickerProps {
  /** Every Agent the person may act as, or null when Main could not list them. */
  options: AgentOption[] | null;
  /** The session Agent, when it is still eligible. */
  current: string | null;
  /** The saved default and its compare-and-set revision. */
  preferred: string | null;
  preferenceRevision: string | null;
  sessionRevision: string | null;
  next: string;
  locale: UiLocale;
  notice: AgentPickerNotice | null;
  messages: AuthMessages;
}

function noticeText(notice: AgentPickerNotice, messages: AuthMessages): string {
  switch (notice.kind) {
    case 'ineligible': return formatMessage(messages.ineligibleAgent,
      { agent: agentName({ iri: notice.previous, label: null }, messages) });
    case 'ineligible-default': return formatMessage(messages.ineligibleDefault,
      { agent: agentName({ iri: notice.previous, label: null }, messages) });
    case 'invalid': return messages.invalidAgent;
    case 'stale-session': return messages.staleSession;
    case 'stale-default': return messages.staleDefault;
    case 'default-not-saved': return messages.defaultNotSaved;
    case 'unavailable': return messages.agentsUnavailable;
  }
}

function kindText(kind: AgentOption['kind'], messages: AuthMessages): string | null {
  switch (kind) {
    case 'person': return messages.personAgent;
    case 'pen-name': return messages.penNameAgent;
    case 'organization': return messages.organizationAgent;
    case 'service': return messages.serviceAgent;
    case null: return null;
  }
}

/** Explicit choice of the session Agent. The optional account-wide main-Agent
 * preference initializes later sessions; Main admits both choices. */
export function AgentPicker({ options, current, preferred, preferenceRevision, sessionRevision, next, locale, notice,
  messages }: AgentPickerProps) {
  const checked = current ?? (sessionRevision === null
    ? preferred ?? (options?.length === 1 ? options[0]!.iri : null) : null);
  return <section className="flex flex-col gap-5">
    <header className="flex flex-col gap-2">
      <h1 className="font-semibold text-2xl">{messages.chooseAgentHeading}</h1>
      <p className="text-muted-foreground">{messages.chooseAgentHelp}</p>
    </header>
    {notice ? <Alert variant={notice.kind === 'default-not-saved' ? 'info' : 'warning'}>
      <AlertDescription role="alert">{noticeText(notice, messages)}</AlertDescription></Alert> : null}
    {options && options.length === 0 ? <div className="grid justify-items-start gap-3">
      <p role="status">{messages.noAgents}</p>
      <LocalizedLink href={`${localizedPath('/onboarding', locale)}?next=${encodeURIComponent(next)}`}
        className="font-medium text-primary underline underline-offset-4">{messages.setUpProfile}</LocalizedLink>
    </div> : null}
    {options?.length ? <form method="post" action="/identity/select" className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="preferenceRevision" value={preferenceRevision ?? ''} />
      <input type="hidden" name="sessionRevision" value={sessionRevision ?? ''} />
      {/* min-w-0: a fieldset is min-content wide by default, and a long IRI would widen the page. */}
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-2 font-medium text-sm">{messages.agentsLegend}</legend>
        {options.map(option => <label key={option.iri} className="flex cursor-pointer items-start gap-3
          rounded-xl border border-border p-3 hover:bg-accent/60 has-checked:border-primary
          has-checked:bg-primary/5 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/32">
          <input type="radio" name="agent" value={option.iri} required defaultChecked={option.iri === checked}
            className="mt-1 size-4 accent-primary" />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium" lang={option.label ? option.labelText?.language : undefined}
                dir={option.label ? option.labelText?.direction : undefined}>{agentName(option, messages)}</span>
              {option.handle ? <span className="text-muted-foreground text-sm">@{option.handle}</span> : null}
              {option.iri === current ? <Badge variant="secondary">{messages.currentAgent}</Badge> : null}
              {option.iri === preferred ? <Badge variant="outline">{messages.defaultAgent}</Badge> : null}
            </span>
            <span className="text-muted-foreground text-sm">{[
              kindText(option.kind, messages), option.path === 'direct-principal' ? messages.directPath
                : option.path === 'represented-agent' ? messages.representedPath : null]
              .filter(Boolean).join(' · ')}</span>
            <code className="truncate font-mono text-muted-foreground text-xs">{option.iri}</code>
          </span>
        </label>)}
      </fieldset>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" name="saveDefault" className="mt-0.5 size-4 accent-primary" />
        <span className="flex flex-col gap-0.5"><span>{messages.saveDefault}</span>
          <span className="text-muted-foreground">{messages.saveDefaultHelp}</span></span>
      </label>
      <Button type="submit" className="self-start">{messages.useAgent}</Button>
    </form> : null}
  </section>;
}
