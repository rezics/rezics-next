import { CopyTextButton } from '../../catalogue/copy-button.tsx';
import type { UiLocale } from '../../../i18n/define.ts';
import type { WorkPageMessages } from '../messages.ts';
import { Region } from '../region.tsx';
import type { HubWorkPage } from '../types.ts';
import { promptRequirements, skillExamples, skillInstallPath, skillInstallText, skillRequirements } from './use-with.ts';

function highlighted(text: string) {
  return text.split(/(\{\{[^{}]{1,64}\}\})/g).map((part, index) => part.startsWith('{{') && part.endsWith('}}')
    ? <mark key={index} className="rounded bg-primary/15 px-0.5 text-foreground">{part}</mark>
    : part);
}

/** Exact publication bytes stay in one copy target; highlighting changes presentation only. */
export function HubExperience({ page, locale, messages: t }: {
  page: HubWorkPage; locale: UiLocale; messages: WorkPageMessages;
}) {
  const prompt = page.kind === 'prompt';
  const variables = page.parameterSchema.properties && typeof page.parameterSchema.properties === 'object'
    ? Object.keys(page.parameterSchema.properties) : [];
  const requirements = prompt ? promptRequirements(page.parameterSchema)
    : skillRequirements(page.content).map(name => ({ name, required: true }));
  const parsedExamples = prompt ? [] : skillExamples(page.content);
  const agents = prompt
    ? [{ id: 'claude', label: 'Claude', lead: t.useClaude, text: page.content },
      { id: 'chatgpt', label: 'ChatGPT', lead: t.useChatGpt, text: page.content },
      { id: 'cursor', label: 'Cursor', lead: t.useCursor, text: page.content }]
    : (['claude', 'cursor', 'codex'] as const).map(agent => ({
      id: agent, label: agent === 'claude' ? 'Claude Code' : agent === 'cursor' ? 'Cursor' : 'Codex',
      lead: agent === 'claude' ? t.useClaudeSkill : agent === 'cursor' ? t.useCursorSkill : t.useCodexSkill,
      text: skillInstallText(agent, page.content), path: skillInstallPath(agent, page.content),
    }));
  return <Region id="hub-experience" title={prompt ? t.promptText : t.skillText}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-muted-foreground text-sm">{prompt ? t.promptPublished : t.skillPublished}</p>
      <CopyTextButton text={page.content} label={prompt ? t.copyPrompt : t.copySkill}
        copied={t.copied} failed={t.copyFailed} />
    </div>
    <pre className="max-h-[38rem] overflow-auto rounded-xl border bg-muted/30 p-4 text-sm leading-7 whitespace-pre-wrap break-words"
      lang="en" dir="auto"><code>{highlighted(page.content)}</code></pre>
    {prompt && variables.length ? <div className="grid gap-2">
      <h3 className="font-semibold">{t.promptVariables}</h3>
      <ul className="flex flex-wrap gap-2">{variables.map(name => <li key={name}
        className="rounded-full border px-3 py-1 font-mono text-sm">{name}</li>)}</ul>
    </div> : null}
    <div className="grid gap-3">
      <h3 className="font-semibold">{t.useWith}</h3>
      <p className="text-muted-foreground text-sm">{prompt ? t.tryPrompt : t.trySkill}</p>
      <ul className="grid gap-3">{agents.map(agent => <li key={agent.id} className="grid gap-2 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-medium">{agent.label}</h4>
          <CopyTextButton text={agent.text} label={prompt ? t.copyPrompt : t.installSkill}
            copied={t.copied} failed={t.copyFailed} />
        </div>
        <p className="text-muted-foreground text-sm">{agent.lead}</p>
        {'path' in agent ? <p className="font-mono text-sm">{agent.path}</p> : null}
      </li>)}</ul>
    </div>
    <div className="grid gap-2">
      <h3 className="font-semibold">{t.requirements}</h3>
      {requirements.length ? <ul className="grid gap-1 text-sm">{requirements.map(item => {
        const description = 'description' in item && typeof item.description === 'string' ? item.description : '';
        return <li key={item.name}>
          <span className="font-mono">{item.name}</span>
          {item.required ? <span className="text-muted-foreground"> · {t.requiredField}</span> : null}
          {description ? <span> — {description}</span> : null}
        </li>;
      })}</ul> : <p className="text-muted-foreground text-sm">{t.noRequirements}</p>}
    </div>
    <div className="grid gap-2">
      <h3 className="font-semibold">{t.testedModels}</h3>
      {page.testedModels.length
        ? <p className="text-sm">{page.testedModels.join(', ')}</p>
        : <p className="text-muted-foreground text-sm">{t.noTestedModels}</p>}
      {page.declaredModels.length ? <p className="text-muted-foreground text-sm">
        {t.declaredModels}: {page.declaredModels.join(', ')}</p> : null}
    </div>
    <div className="grid gap-3">
      <h3 className="font-semibold">{t.promptExamples}</h3>
      {page.examples.length ? page.examples.map((example, index) => <div key={index}
        className="grid gap-2 rounded-xl border p-4">
        <h4 className="font-medium">{t.example} {index + 1}</h4>
        <dl className="grid gap-1 text-sm">{Object.entries(example.parameters).map(([name, value]) => <div key={name}>
          <dt className="font-mono text-muted-foreground">{name}</dt>
          <dd className="whitespace-pre-wrap">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
        </div>)}</dl>
        <p className="whitespace-pre-wrap text-sm">{example.output}</p>
      </div>) : null}
      {parsedExamples.map((example, index) => <pre key={index}
        className="overflow-x-auto whitespace-pre-wrap rounded-xl border p-4 text-sm">{example}</pre>)}
      {page.examples.length || parsedExamples.length ? null
        : <p className="text-muted-foreground text-sm">{t.noExamples}</p>}
    </div>
    <div className="grid gap-2">
      <h3 className="font-semibold">{t.versionHistory}</h3>
      <ol className="grid gap-1 text-sm">{page.versions.map((version, index) => <li key={version.revision}>
        {index === 0 ? t.currentVersion : t.earlierVersion} · {version.createdAt
          ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(version.createdAt))
          : t.dateUnavailable}
      </li>)}</ol>
      {page.moreVersions ? <p className="text-muted-foreground text-sm">{t.moreVersions}</p> : null}
    </div>
  </Region>;
}
