'use client';

import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Spinner } from '@rezics/ui/spinner';
import { cn } from '@rezics/ui/utils';
import { CheckIcon, CopyIcon, GitCompareArrowsIcon } from 'lucide-react';
import { useState } from 'react';
import { diffParagraphs } from './diff.ts';
import { DocumentBody } from '@rezics/ui/document-body';
import { parseStoredDocument } from '@rezics/document';
import { bodyText } from '../document-editor/body.ts';
import { messages as documentMessages } from '../document-editor/messages.ts';
import type { UiLocale } from '../../i18n/define.ts';

export interface ConflictLabels {
  conflictTitle: string;
  conflictBody: string;
  compareHeading: string;
  yours: string;
  theirs: string;
  onlyYours: string;
  onlyTheirs: string;
  keepMine: string;
  keepMineHelp: string;
  takeTheirs: string;
  copyMine: string;
  copied: string;
  theirsUnavailable: string;
}

/**
 * What to do when someone saved this text first: the two versions side by side
 * (stacked on phones) with the paragraphs only one of them has marked, and an
 * explicit choice. Nothing is saved until the writer chooses.
 */
export function ConflictView({
  mine,
  theirs,
  lang,
  dir,
  busy = false,
  onKeepMine,
  onTakeTheirs,
  labels,
  locale = 'en',
}: {
  mine: string;
  /** The version saved elsewhere; undefined while it is read, null when Main cannot give it. */
  theirs: string | null | undefined;
  lang: string;
  dir?: 'ltr' | 'rtl';
  busy?: boolean;
  onKeepMine: () => void;
  onTakeTheirs: () => void;
  labels: ConflictLabels;
  locale?: UiLocale;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(bodyText(mine));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const runs = typeof theirs === 'string' ? diffParagraphs(bodyText(mine), bodyText(theirs)) : null;
  const rich = (side: 'mine' | 'theirs') =>
    parseStoredDocument(side === 'mine' ? mine : (theirs ?? ''));
  const column = (side: 'mine' | 'theirs') => (
    <div className="grid min-w-0 content-start gap-2">
      <h3 className="font-medium text-sm">{side === 'mine' ? labels.yours : labels.theirs}</h3>
      <div
        lang={lang}
        dir={dir}
        className="grid max-h-[50dvh] gap-2 overflow-y-auto rounded-2xl border border-border/60
      bg-background p-4 font-work-title text-base/[1.8] [overflow-wrap:anywhere] [text-autospace:normal]"
      >
        {rich(side) ? (
          <DocumentBody
            document={rich(side)!}
            unknownComponentLabel={documentMessages[locale].unknownComponent}
            spoilerLabel={documentMessages[locale].revealSpoiler}
          />
        ) : (
          runs
            ?.filter((run) => run.kind === 'both' || run.kind === side)
            .flatMap((run, index) =>
              run.lines.map((line, at) => (
                <p
                  key={`${index}-${at}`}
                  className={cn(
                    run.kind !== 'both' &&
                      (side === 'mine'
                        ? 'rounded-md bg-info/10 px-1.5 text-info-foreground'
                        : 'rounded-md bg-warning/10 px-1.5 text-warning-foreground'),
                  )}
                >
                  {run.kind !== 'both' ? (
                    <span className="sr-only">
                      {side === 'mine' ? labels.onlyYours : labels.onlyTheirs}:{' '}
                    </span>
                  ) : null}
                  {line || ' '}
                </p>
              )),
            )
        )}
      </div>
    </div>
  );
  return (
    <section
      aria-labelledby="studio-conflict"
      className="grid gap-4 rounded-3xl border border-warning/40
    bg-warning/5 p-4 sm:p-6"
    >
      <Alert variant="warning" className="border-0 bg-transparent p-0">
        <GitCompareArrowsIcon aria-hidden="true" />
        <AlertTitle id="studio-conflict" role="alert">
          {labels.conflictTitle}
        </AlertTitle>
        <AlertDescription>{labels.conflictBody}</AlertDescription>
      </Alert>
      {theirs === undefined ? (
        <p role="status" className="flex items-center gap-2 text-muted-foreground text-sm">
          <Spinner aria-hidden="true" className="size-4" />
          {labels.compareHeading}
        </p>
      ) : null}
      {theirs === null ? <p className="text-sm">{labels.theirsUnavailable}</p> : null}
      {runs ? (
        <div className="grid gap-4">
          <h2 className="sr-only">{labels.compareHeading}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {column('mine')}
            {column('theirs')}
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {/* Keeping mine saves on top of the other version's head, so both choices wait until it is known. */}
        {typeof theirs === 'string' ? (
          <>
            <Button type="button" onClick={onKeepMine} disabled={busy}>
              {labels.keepMine}
            </Button>
            <Button type="button" variant="outline" onClick={onTakeTheirs} disabled={busy}>
              {labels.takeTheirs}
            </Button>
          </>
        ) : null}
        <Button type="button" variant="ghost" onClick={() => void copy()}>
          {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          {copied ? labels.copied : labels.copyMine}
        </Button>
      </div>
      {typeof theirs === 'string' ? (
        <p className="text-muted-foreground text-xs">{labels.keepMineHelp}</p>
      ) : null}
    </section>
  );
}
