import { KeyRound, Lock, Wallet } from 'lucide-react';
import type { JSX } from 'react';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';

/** What every illustration and vignette takes: the interface words, which sample content never uses. */
export type Words = { words: IllustrationCopy };

/** One line of a small list inside a vignette or plate. */
export const row =
  'flex items-center justify-between gap-3 rounded-xl border border-border bg-background px-3 py-2 text-sm';

/** A vignette: a small picture keyed by the showcase tile it sits in. */
export type Picture = (props: Words) => JSX.Element;

/** An agent's connection: the scopes it holds, the MCP server it reaches and the budget its owner set. */
export function Connect({ words }: Words) {
  const w = words.agent;
  return (
    <dl className="grid w-full max-w-xs gap-2 text-sm">
      <div className={row}>
        <dt className="flex items-center gap-2 text-muted-foreground">
          <KeyRound aria-hidden className="size-4" />
          {w.scopes}
        </dt>
        <dd translate="no" className="font-mono text-xs">
          tags:propose
        </dd>
      </div>
      <div className={row}>
        <dt className="flex items-center gap-2 text-muted-foreground">
          <Lock aria-hidden className="size-4" />
          MCP
        </dt>
        <dd lang="en" className="truncate">
          Salt Marsh Readers
        </dd>
      </div>
      <div className={row}>
        <dt className="flex items-center gap-2 text-muted-foreground">
          <Wallet aria-hidden className="size-4" />
          {w.budget}
        </dt>
        <dd>{w.setByYou}</dd>
      </div>
    </dl>
  );
}
