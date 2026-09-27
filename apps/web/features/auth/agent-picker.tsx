import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { type AgentOption, agentName } from './acting-identity.ts';
import { type AuthMessages, formatMessage } from './messages.ts';

export type AgentPickerNotice =
  | { kind: 'ineligible'; previous: string }
  | { kind: 'invalid' | 'stale-default' | 'default-not-saved' | 'unavailable' };

export interface AgentPickerProps {
  /** Eligible Agents, or null when Main could not list them. */
  options: AgentOption[] | null;
  /** The session Agent, when it is still eligible. */
  current: string | null;
  /** The saved default and its compare-and-set revision. */
  preferred: string | null;
  preferenceRevision: string | null;
  next: string;
  notice: AgentPickerNotice | null;
  messages: AuthMessages;
}

function noticeText(notice: AgentPickerNotice, messages: AuthMessages): string {
  switch (notice.kind) {
    case 'ineligible': return formatMessage(messages.ineligibleAgent,
      { agent: agentName({ iri: notice.previous, label: null }, messages) });
    case 'invalid': return messages.invalidAgent;
    case 'stale-default': return messages.staleDefault;
    case 'default-not-saved': return messages.defaultNotSaved;
    case 'unavailable': return messages.agentsUnavailable;
  }
}

/** Explicit choice of the session Agent. Choosing changes this session only;
 * "make this my default" also saves the `work.create` preference, which starts
 * new sign-ins and proposes the Agent for new Works. */
export function AgentPicker({ options, current, preferred, preferenceRevision, next, notice,
  messages }: AgentPickerProps) {
  const checked = current ?? (options?.length === 1 ? options[0]!.iri : null);
  return <section className="flex flex-col gap-5">
    <header className="flex flex-col gap-2">
      <h1 className="font-semibold text-2xl">{messages.chooseAgentHeading}</h1>
      <p className="text-muted-foreground">{messages.chooseAgentHelp}</p>
    </header>
    {notice ? <Alert variant={notice.kind === 'default-not-saved' ? 'info' : 'warning'}>
      <AlertDescription role="alert">{noticeText(notice, messages)}</AlertDescription></Alert> : null}
    {options && options.length === 0 ? <p role="status">{messages.noAgents}</p> : null}
    {options?.length ? <form method="post" action="/identity/select" className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="preferenceRevision" value={preferenceRevision ?? ''} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 font-medium text-sm">{messages.agentsLegend}</legend>
        {options.map(option => <label key={option.iri} className="flex cursor-pointer items-start gap-3
          rounded-xl border border-border p-3 hover:bg-accent/60 has-checked:border-primary
          has-checked:bg-primary/5 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/32">
          <input type="radio" name="agent" value={option.iri} required defaultChecked={option.iri === checked}
            className="mt-1 size-4 accent-primary" />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{agentName(option, messages)}</span>
              {option.iri === current ? <Badge variant="secondary">{messages.currentAgent}</Badge> : null}
              {option.iri === preferred ? <Badge variant="outline">{messages.defaultAgent}</Badge> : null}
            </span>
            <span className="text-muted-foreground text-sm">{option.path === 'direct-principal'
              ? messages.directPath : messages.representedPath}</span>
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
