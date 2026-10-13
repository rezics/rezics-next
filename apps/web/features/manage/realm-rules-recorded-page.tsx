'use client';

import { Button } from '@rezics/ui/button';
import { PencilIcon, ScaleIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useEffect, useState } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { signInPath } from '../auth/paths.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { messages as realmMessages, type RealmMessages } from '../realm/messages.ts';
import realmDe from '../realm/messages/de.ts';
import realmEs from '../realm/messages/es.ts';
import realmFr from '../realm/messages/fr.ts';
import realmJa from '../realm/messages/ja.ts';
import realmKo from '../realm/messages/ko.ts';
import realmZhHans from '../realm/messages/zh-Hans.ts';
import realmZhHant from '../realm/messages/zh-Hant.ts';
import { realmHref } from '../realm/route.ts';
import { RealmAbout } from '../realm/views.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { PageContainer, PageHeader } from '../shell/page.tsx';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { PrivateSpaceJoinPage } from '../space-access/join-page.tsx';
import { messages as manageMessages, type ManageMessages } from './messages.ts';
import manageDe from './messages/de.ts';
import manageEs from './messages/es.ts';
import manageFr from './messages/fr.ts';
import manageJa from './messages/ja.ts';
import manageKo from './messages/ko.ts';
import manageZhHans from './messages/zh-Hans.ts';
import manageZhHant from './messages/zh-Hant.ts';
import { RealmFrame } from './realm-frame.tsx';
import { RevisionBadge, RuleList } from './rule-list.tsx';
import { draftsOf, RulesEditor, type RuleDraft } from './rules-editor.tsx';
import type { RuleMeaning } from './rules.ts';
import { uuidOf, type RealmHeader, type RealmRule, type SettingsView } from './types.ts';
import {
  readRealmRulesRecorded,
  type PublishedRealmRule,
  type RealmRulesMapped,
  type RealmRulesProblem,
  type RealmRulesRecordedLoad,
} from './realm-rules-recorded-page.ts';
import type { ZoneText } from '../realm/adapt.ts';

const realmOverlays = new Map<UiLocale, Partial<RealmMessages>>([
  ['zh-Hant', realmZhHant], ['zh-Hans', realmZhHans], ['ja', realmJa], ['ko', realmKo],
  ['de', realmDe], ['fr', realmFr], ['es', realmEs],
]);
const manageOverlays = new Map<UiLocale, Partial<ManageMessages>>([
  ['zh-Hant', manageZhHant], ['zh-Hans', manageZhHans], ['ja', manageJa], ['ko', manageKo],
  ['de', manageDe], ['fr', manageFr], ['es', manageEs],
]);

function PublishedRules({ name, rules, locale, messages }: {
  name: ZoneText; rules: readonly PublishedRealmRule[] | null; locale: UiLocale; messages: RealmMessages;
}) {
  return <>
    <PageContainer className="pb-0">
      <PageHeader title={<span lang={name.lang} dir={name.dir}>{name.value}</span>} />
    </PageContainer>
    <RealmAbout only="rules" realmName={name.value} description={null} moderators={null} members={null} listed={null}
      others={[]} locale={locale} messages={messages} rules={rules} />
  </>;
}

function RulesSection({ rules, basis, problem, locale, messages }: {
  rules: readonly RealmRule[]; basis: RuleMeaning; problem: RealmRulesProblem | null;
  locale: UiLocale; messages: ManageMessages;
}) {
  const t = materializeData(messages, { locale });
  const [drafts, setDrafts] = useState<RuleDraft[] | null>(null);
  return <section aria-labelledby="realm-rules" className="grid gap-4">
    {problem ? <p role="alert">{problem.title}</p> : null}
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="realm-rules" className="font-semibold text-xl tracking-tight">{t.rulesTitle}</h2>
          <RevisionBadge meaning={basis} locale={locale} messages={messages} />
        </div>
        <p className="max-w-2xl text-muted-foreground text-sm">{t.rulesHelp}</p>
      </div>
      {!drafts && rules.length ? <Button variant="outline" size="sm" onClick={() => setDrafts(draftsOf(rules))}>
        <PencilIcon aria-hidden="true" />{t.editRules}</Button> : null}
    </div>
    {drafts ? <RulesEditor drafts={drafts} published={rules} problems={null} locale={locale} messages={messages}
      onChange={setDrafts} />
      : rules.length ? <RuleList rules={rules} locale={locale} messages={messages} />
        : <EmptyState icon={ScaleIcon} title={t.noRulesTitle} description={t.noRulesHelp}>
          <Button size="sm" onClick={() => setDrafts(draftsOf(rules))}>{t.addRule}</Button>
        </EmptyState>}
  </section>;
}

function RecordedSettings({ realm, header, agent, settings, problem, locale, messages }: {
  realm: string | null; header: RealmHeader | null; agent: AgentOption | null; settings: SettingsView;
  problem: RealmRulesProblem | null; locale: UiLocale; messages: ManageMessages;
}) {
  const section = <RulesSection rules={settings.settings.rules} basis={settings.ruleBasis} problem={problem}
    locale={locale} messages={messages} />;
  if (!realm || !agent) return section;
  return <RealmFrame realm={realm} header={header} agent={agent} locale={locale} messages={messages} settingsAllowed>
    {section}
  </RealmFrame>;
}

function RecordedBody({ load, locale }: { load: RealmRulesRecordedLoad; locale: UiLocale }) {
  const realm = { ...realmMessages, ...realmOverlays.get(locale) };
  const manage = { ...manageMessages, ...manageOverlays.get(locale) };
  const mapped: RealmRulesMapped = load.mapped;
  if (mapped.kind === 'discrepancy') return <p role="alert">{mapped.detail}</p>;
  if (mapped.kind === 'published') return <PublishedRules name={mapped.name} rules={mapped.rules} locale={locale} messages={realm} />;
  if (mapped.kind === 'empty') return <PublishedRules name={mapped.name} rules={[]} locale={locale} messages={realm} />;
  if (mapped.kind === 'landing') {
    return <PrivateSpaceJoinPage page={mapped.page} discoveryMetadata={false} persist={false} locale={locale}
      actingSubject={null} signInHref={signInPath(realmHref(locale, uuidOf(mapped.page.id), 'rules'))} />;
  }
  if (mapped.kind === 'settings' || (mapped.kind === 'refused' && mapped.accepted)) {
    return <RecordedSettings realm={mapped.realm} header={mapped.header} agent={mapped.agent}
      settings={mapped.kind === 'settings' ? mapped.settings : mapped.accepted!}
      problem={mapped.kind === 'refused' ? mapped.problem : null} locale={locale} messages={manage} />;
  }
  if (mapped.kind === 'refused') return <p role="alert">{mapped.problem.title}</p>;
  return null;
}

/** One recorded Realm rules page. The selections name the answers; the shared mapping decides what is shown. */
export function RealmRulesRecordedPage({ record, persona, selections, locale }: {
  record: AnswerRecord; persona: AnswerPersona; selections: readonly RecordedSelection[]; locale: UiLocale;
}) {
  const [load, setLoad] = useState<RealmRulesRecordedLoad | null>(null);
  useEffect(() => {
    let mounted = true;
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    void readRealmRulesRecorded(replay.fetcher, record, persona, selections).then(result => {
      if (mounted) setLoad(result);
    }).catch((error: unknown) => {
      if (!mounted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setLoad({ mapped: { kind: 'discrepancy', detail: error instanceof Error ? error.message : String(error) } });
    });
    return () => { mounted = false; replay.dispose(); };
  }, [record, persona, selections]);
  if (!load) return <p role="status" aria-busy="true">{shellMessages.loading}</p>;
  return <RecordedBody load={load} locale={locale} />;
}
