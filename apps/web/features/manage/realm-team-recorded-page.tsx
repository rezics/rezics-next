'use client';

import { useEffect, useState } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { signInPath } from '../auth/paths.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { bffAdminApi, type AdminApi } from './admin-api.ts';
import { readRealmHeader } from './read.ts';
import { ManageFailure } from './parts.tsx';
import { MembersView } from './members-view.tsx';
import { managementMessages } from './localized-messages.ts';
import { RealmFrame } from './realm-frame.tsx';
import {
  mapRealmMembers, mapRealmRoles, readManagementActor, readRealmMembersPage, readRealmRolesPage,
  readRealmTeamFrame, type RealmTeamFrame,
} from './realm-team-recorded-page.ts';
import { realmHref } from './routes.ts';
import { RolesView } from './roles-view.tsx';

const recordedOrigin = 'https://recorded.invalid';

function unsignedAgent(iri: string): AgentOption {
  return { iri, label: null, handle: null, kind: null, path: null };
}

interface ShownTeam {
  frame: RealmTeamFrame;
  agent: AgentOption;
  api: AdminApi;
  now: number;
  mapped: ReturnType<typeof mapRealmRoles> | ReturnType<typeof mapRealmMembers>;
  agents: ShownAgents;
}

type ShownAgents = Awaited<ReturnType<typeof readRealmRolesPage>>['agents'];

/**
 * Roles and members from recorded answers. The selections name which recorded
 * response each production read receives; the reads are the route's own.
 * An unsigned visitor never reaches the layout, so this page does not issue
 * the layout's Zone read for that persona: the recorded Zone read has no
 * acting subject, and the layout always sends one.
 */
export function RealmTeamRecordedPage({ record, persona, selections, surface, locale, realm, actingSubject }: {
  record: AnswerRecord;
  persona: AnswerPersona;
  selections: readonly RecordedSelection[];
  surface: 'roles' | 'members';
  locale: UiLocale;
  realm: string;
  actingSubject: string;
}) {
  const [shown, setShown] = useState<ShownTeam | null>(null);
  const [discrepancy, setDiscrepancy] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    const fetcher = replay.fetcher;
    const main = () => browserMainApi(recordedOrigin, { fetcher });
    const anonymous = () => browserMainApi(recordedOrigin, { anonymous: true, fetcher });
    const fail = (error: unknown) => {
      if (!mounted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setShown(null);
      setDiscrepancy(error instanceof Error ? error.message : String(error));
    };
    void (async () => {
      const signedIn = persona !== 'visitor';
      const agent = signedIn ? await readManagementActor(main(), locale) : unsignedAgent(actingSubject);
      if (agent.iri !== actingSubject) throw new Error(`Session agent ${agent.iri} is not the route actor`);
      const clients = { main: main(), anonymous: anonymous() };
      const frameRead = signedIn
        ? readRealmTeamFrame(main(), realm, agent.iri, locale)
        : readRealmHeader(main(), realm, locale, agent.iri).then(header => ({
          header: header.ok ? header.data : null, siteHref: null,
        }));
      const [frame, mapped, agents] = surface === 'roles'
        ? await Promise.all([frameRead, readRealmRolesPage(clients, { realm, actingSubject: agent.iri })])
          .then(([ready, roles]) => [ready, mapRealmRoles(roles.roles), roles.agents] as const)
        : await Promise.all([frameRead, readRealmMembersPage(clients, { realm, actingSubject: agent.iri })])
          .then(([ready, members]) => [ready, mapRealmMembers(members.page, members.roles, members.invitations, null),
            members.agents] as const);
      if (!mounted) return;
      setDiscrepancy(null);
      setShown({
        frame, agent, mapped, agents, now: Date.now(),
        api: bffAdminApi(realm, agent.iri, main),
      });
    })().catch(fail);
    return () => { mounted = false; replay.dispose(); };
  }, [record, persona, selections, surface, locale, realm, actingSubject]);
  const messages = managementMessages(locale);
  if (discrepancy) return <p role="alert">{discrepancy}</p>;
  if (!shown) return <p role="status" aria-busy="true">{shellMessages.loading}</p>;
  const back = localizedPath(realmHref(realm, surface), locale);
  const body = shown.mapped.kind === 'refusal'
    ? <ManageFailure failure={shown.mapped.failure} locale={locale} messages={messages} signInHref={signInPath(back)}
      retryHref={back} />
    : shown.mapped.kind === 'roles'
      ? <RolesView principal="" realm={realm} actingSubject={shown.agent.iri} list={shown.mapped.list}
        agents={shown.agents} locale={locale} messages={messages} api={shown.api} />
      : <MembersView principal="" realm={realm} actingSubject={shown.agent.iri} first={shown.mapped.page}
        agents={shown.agents} invitations={shown.mapped.invitations} roles={shown.mapped.roles}
        roleFilter={shown.mapped.roleFilter} now={shown.now} locale={locale} messages={messages} api={shown.api} />;
  return <RealmFrame realm={realm} header={shown.frame.header} agent={shown.agent} locale={locale} messages={messages}
    siteHref={shown.frame.siteHref}>
    {body}
  </RealmFrame>;
}
