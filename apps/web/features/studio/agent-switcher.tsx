'use client';

import { Button } from '@rezics/ui/button';
import { Menu, MenuContent, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from '@rezics/ui/menu';
import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import type { AgentOption } from '../auth/acting-identity.ts';
import Link from '../shell/localized-link.tsx';
import { studioHref } from './agent.ts';

export interface SwitcherLabels { switchIdentity: string; identities: string; manageIdentities: string }

/**
 * Opens the same Studio page as another of this person's Agents. Each choice is
 * a link to that Agent's own address, so it opens in this tab only and never
 * changes the session Agent or another tab's Studio.
 */
export function AgentSwitcher({ current, agents, path, names, labels }: {
  current: AgentOption; agents: readonly AgentOption[];
  /** The Studio sub-path to keep, such as `` or `/new`; Work pages go back to the Studio home. */
  path: string; names: Record<string, string>; labels: SwitcherLabels;
}) {
  return <Menu>
    <MenuTrigger asChild>
      <Button type="button" variant="outline" size="sm"><ChevronsUpDownIcon aria-hidden="true" />{labels.switchIdentity}</Button>
    </MenuTrigger>
    <MenuContent className="w-72">
      <MenuGroup heading={labels.identities}>
        {agents.map(agent => <MenuItem key={agent.iri} value={agent.iri} asChild>
          <Link href={studioHref(agent, path)} aria-current={agent.iri === current.iri ? 'page' : undefined}>
            <span className="min-w-0 flex-1 truncate">{names[agent.iri]}</span>
            {agent.iri === current.iri ? <CheckIcon aria-hidden="true" className="size-4 text-primary" /> : null}
          </Link>
        </MenuItem>)}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem value="manage" asChild><Link href="/identity">{labels.manageIdentities}</Link></MenuItem>
    </MenuContent>
  </Menu>;
}
