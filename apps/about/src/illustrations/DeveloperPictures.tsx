import { Badge } from '@rezics/ui/badge';
import { WorkCover } from '@rezics/ui/work-cover';
import { cn } from '@rezics/ui/utils';
import { Check, CircleDashed, Clock, KeyRound, Radio, WifiOff } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { fill } from '../i18n/fill.ts';
import { localeNames } from '../i18n/locales.ts';
import { Connect, row, type Picture, type Words } from './parts.tsx';
import { Plate } from './Plate.tsx';
import { lantern } from './sample.ts';

const at = (percent: number) => ({ '--at': percent }) as CSSProperties;

/** Code as it is: English, unhyphenated, never translated. `dim` marks the parts a reader can skip. */
function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      lang="en"
      translate="no"
      className={cn(
        'w-full overflow-hidden rounded-2xl border border-border bg-card px-4 py-3 font-mono text-[0.8125rem] leading-relaxed',
        className,
      )}
    >
      {children}
    </pre>
  );
}
const Dim = ({ children }: { children: ReactNode }) => (
  <span className="text-muted-foreground">{children}</span>
);

const path = '/imports';

/* ---------- Hero ---------- */

/** The website and a script asking for the same thing: the same editions, from the same operation. */
export function TwoClients({ words }: Words) {
  const a = words.api;
  return (
    <Plate className="flex flex-col gap-4">
      <p className="text-sm font-semibold text-muted-foreground">{a.sameOperation}</p>
      <div className="grid items-stretch gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-border bg-background p-3.5">
          <p className="mb-3 text-xs font-semibold text-muted-foreground">{a.website}</p>
          <p className="flex items-center gap-3">
            <WorkCover
              kind="book"
              id={lantern.id}
              title={lantern.editions[1].title}
              lang="zh-Hant"
              className="w-[4.5rem] shrink-0 rounded-[3px]"
            />
            <span>
              <span lang="zh-Hant" className="block font-work-title font-semibold">
                {lantern.editions[1].title}
              </span>
              <span lang="zh-Hant" className="block text-sm text-muted-foreground">
                {localeNames['zh-Hant']} · 6
              </span>
            </span>
          </p>
        </div>
        <div data-arrive className="flex flex-col gap-2">
          <p className="text-xs font-semibold text-muted-foreground">{a.yourCode}</p>
          <Code className="flex-1 px-3 py-2.5 text-xs">
            <Dim>GET</Dim>
            {' /works/7d1f…/editions\n     ?language=zh-Hant\n'}
            <Dim>200 </Dim>
            {'{ "title": "燈籠書庫",\n  "volumes": 6 }'}
          </Code>
        </div>
      </div>
    </Plate>
  );
}

/* ---------- One task, one step at a time ---------- */

function Credential({ words }: Words) {
  const a = words.api;
  return (
    <>
      <p className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 font-semibold">
          <KeyRound aria-hidden className="size-4 text-primary" />
          {a.credential}
        </span>
        <Badge variant="outline" size="md">
          {a.revocableHere}
        </Badge>
      </p>
      <ul className="flex flex-col gap-2">
        {[
          { name: words.agent.scopes, value: 'library:import', code: true },
          { name: a.oneLibrary, value: 'Salt Marsh Readers', code: false },
          { name: a.oneTask, value: 'import', code: true },
        ].map((item, index) => (
          <li key={item.name} data-arrive style={at(index * 6)} className={row}>
            <span className="text-muted-foreground">{item.name}</span>
            <span
              lang="en"
              translate="no"
              className={cn(item.code && 'font-mono text-xs', 'font-semibold')}
            >
              {item.value}
            </span>
          </li>
        ))}
      </ul>
      <span className="inline-flex w-fit items-center rounded-full border border-border px-3 py-1.5 text-sm font-semibold text-destructive-foreground">
        {a.revoke}
      </span>
    </>
  );
}

function Prepare({ words }: Words) {
  return (
    <>
      <Code>
        <Dim>POST</Dim>
        {` ${path}/prepare\n`}
        <Dim>200 </Dim>
        {'{ "matched": 212, "choose": 6,\n  "notCarried": ["shelfColours"] }'}
      </Code>
      <ul className="flex flex-col gap-2">
        <li data-arrive className={row}>
          <span>{fill(words.agent.matchedCount, { n: 212 })}</span>
          <Check aria-hidden className="size-4 text-success-foreground" />
        </li>
        <li data-arrive style={at(6)} className={cn(row, 'border-primary')}>
          <span>{fill(words.agent.chooseCount, { n: 6 })}</span>
          <span className="size-2 rounded-full bg-primary" />
        </li>
        <li data-arrive style={at(12)} className={row}>
          <span>{words.importer.notCarried}</span>
          <CircleDashed aria-hidden className="size-4 text-muted-foreground" />
        </li>
      </ul>
    </>
  );
}

/** A retry after a timeout: the same key, the same receipt, no second import. */
function Apply({ words }: Words) {
  const a = words.api;
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <p className="flex items-center justify-between gap-2 text-sm">
          <span className="font-semibold">{a.firstAttempt}</span>
          <Badge variant="warning" size="sm">
            <Clock aria-hidden />
            408
          </Badge>
        </p>
        <Code>
          <Dim>POST</Dim>
          {` ${path}/apply\n`}
          <Dim>Idempotency-Key: </Dim>
          {'4c1e-9a70'}
        </Code>
      </div>
      <div data-arrive className="flex flex-col gap-1.5">
        <p className="flex items-center justify-between gap-2 text-sm">
          <span className="font-semibold">{a.retry}</span>
          <Badge variant="success" size="sm">
            <Check aria-hidden />
            {a.sameReceipt}
          </Badge>
        </p>
        <Code className="border-primary">
          <Dim>POST</Dim>
          {` ${path}/apply\n`}
          <Dim>Idempotency-Key: </Dim>
          {'4c1e-9a70\n'}
          <Dim>200 </Dim>
          {'{ "receipt": "rc_8f3a" }'}
        </Code>
      </div>
    </>
  );
}

/** Events read with a durable cursor: after a disconnect the stream resumes at the marked event. */
function Follow({ words }: Words) {
  const a = words.api;
  const events = [
    { id: 'evt_101', name: 'import.applied', done: true },
    { id: 'evt_102', name: 'shelf.updated', done: true },
    { id: 'evt_103', name: 'wiki.linked', done: false },
    { id: 'evt_104', name: 'export.ready', done: false },
  ];
  return (
    <>
      <p className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-semibold">
          <Radio aria-hidden className="size-4 text-primary" />
          {a.cursor}
        </span>
        <span lang="en" translate="no" className="font-mono text-xs">
          evt_102
        </span>
      </p>
      <ul lang="en" translate="no" className="flex flex-col gap-2 font-mono text-xs">
        {events.map((event, index) => (
          <li key={event.id} className="relative">
            <div
              data-arrive={event.done ? undefined : ''}
              style={event.done ? undefined : at(index * 4)}
              className={cn(
                row,
                'font-mono text-xs',
                event.id === 'evt_102' && 'border-primary bg-accent',
                !event.done && 'border-dashed',
              )}
            >
              <span>{event.id}</span>
              <span className="text-muted-foreground">{event.name}</span>
            </div>
            {event.id === 'evt_102' ? (
              <span className="ribbon absolute -end-1 -top-2 h-6 w-2.5" aria-hidden="true" />
            ) : null}
          </li>
        ))}
      </ul>
      <p className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <WifiOff aria-hidden className="size-4" />
          {a.disconnected}
        </span>
        <span className="font-semibold text-primary">{a.resumeHere}</span>
      </p>
    </>
  );
}

export type ApiStage = 'credential' | 'prepare' | 'apply' | 'follow';

/** Importing a library through the API, the way the website does it, a stage at a time. */
export function ApiFlow({ words, stage }: Words & { stage: ApiStage }) {
  return (
    <Plate className="flex flex-col gap-4">
      {stage === 'credential' ? <Credential words={words} /> : null}
      {stage === 'prepare' ? <Prepare words={words} /> : null}
      {stage === 'apply' ? <Apply words={words} /> : null}
      {stage === 'follow' ? <Follow words={words} /> : null}
    </Plate>
  );
}

/* ---------- Showcase vignettes ---------- */

function Errors({ words }: Words) {
  const a = words.api;
  return (
    <div className="flex w-full max-w-sm flex-col gap-2">
      <Code className="px-3 py-2.5 text-xs">
        <Dim>422 </Dim>
        {'{ "type": "…/scope-missing",\n  "detail": "library:import\n   is not granted" }'}
      </Code>
      <p className="flex items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">{a.nextStep}</span>
        <span lang="en" translate="no" className="font-mono text-xs font-semibold">
          POST /credentials
        </span>
      </p>
    </div>
  );
}

function Sdk({ words }: Words) {
  return (
    <div className="flex w-full max-w-sm flex-col gap-2">
      <Code className="px-3 py-2.5 text-xs">
        {'const editions = await\n  rezics.works.editions(id, {\n    language: '}
        <span className="text-primary">{"'zh-Hant'"}</span>
        {'\n  });'}
      </Code>
      <Badge variant="outline" size="md" className="self-start">
        {words.api.typed}
      </Badge>
    </div>
  );
}

function Portal({ words }: Words) {
  return (
    <ul lang="en" translate="no" className="flex w-full max-w-sm flex-col gap-2">
      {['GET /works/{id}/editions', 'POST /libraries/{id}/imports'].map((operation) => (
        <li key={operation} className={cn(row, 'font-mono text-xs')}>
          <span>{operation}</span>
          <Badge variant="outline" size="sm" className="font-sans">
            {words.api.generated}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

export const developerVignettes: Record<string, Picture> = {
  errors: Errors,
  sdk: Sdk,
  mcp: Connect,
  portal: Portal,
};
