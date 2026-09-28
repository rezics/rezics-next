import { CopyTextButton } from '../../catalogue/copy-button.tsx';
import type { UiLocale } from '../../../i18n/define.ts';
import type { WorkPageMessages } from '../messages.ts';
import { Region } from '../region.tsx';
import type { HubWorkPage } from '../types.ts';

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
    <div className="grid gap-2 rounded-xl bg-muted/40 p-4">
      <h3 className="font-semibold">{t.tryIt}</h3>
      <p className="text-muted-foreground text-sm">{prompt ? t.tryPrompt : t.trySkill}</p>
    </div>
    <div className="grid gap-2">
      <h3 className="font-semibold">{t.testedModels}</h3>
      <p className="text-muted-foreground text-sm">{page.testedModels.length
        ? page.testedModels.join(', ') : t.noTestedModels}</p>
      {page.declaredModels.length ? <p className="text-muted-foreground text-sm">
        {t.declaredModels}: {page.declaredModels.join(', ')}</p> : null}
    </div>
    <div className="grid gap-3">
      <h3 className="font-semibold">{t.promptExamples}</h3>
      {page.examples.length ? page.examples.map((example, index) => <div key={index}
        className="grid gap-2 rounded-xl border p-4">
        <h4 className="font-medium">{t.example} {index + 1}</h4>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-sm">{JSON.stringify(example.parameters, null, 2)}</pre>
        <p className="text-muted-foreground text-sm">{example.output}</p>
      </div>) : <p className="text-muted-foreground text-sm">{t.noExamples}</p>}</div>
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
