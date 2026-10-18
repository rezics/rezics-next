'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { CookingPotIcon } from 'lucide-react';
import { CopyTextButton } from '../../catalogue/copy-button.tsx';
import type { StatusWords } from '../../catalogue/reader-actions.tsx';
import type { UiLocale } from '../../../i18n/define.ts';
import type { WorkPageMessages } from '../messages.ts';
import type { ExperienceKind } from '../../entity-page/experience.ts';
import { ACTION_ATTRIBUTE } from '../hub.ts';

/** Opens cooking mode on the recipe already on this page. */
export function CookThisButton({ label }: { label: string }) {
  return <Button type="button" size="lg" pill {...{ [ACTION_ATTRIBUTE]: '' }} onClick={() => {
    document.getElementById('recipe-experience')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.dispatchEvent(new Event('rezics-cook'));
  }}><CookingPotIcon aria-hidden="true" />{label}</Button>;
}

/**
 * The header action for the page the reader is already on: cook a recipe,
 * copy a prompt, or install a skill. A book keeps Read, drawn by the frame.
 */
export function WorkKindActions({ kind, messages: t, hubText }: {
  kind: ExperienceKind; workId: string; title: string; locale: UiLocale; messages: WorkPageMessages;
  /** The shelf words in the Work's own verb (`shelfWords`); the reading words when left out. */
  words?: StatusWords;
  /** Published prompt or SKILL.md, when the header can copy it. */
  hubText?: string | null;
}) {
  if (kind === 'book') return null;
  if (kind === 'guide') {
    return <a className={buttonVariants({ size: 'lg', pill: true })} {...{ [ACTION_ATTRIBUTE]: '' }} href="#guide-experience">{t.viewGuide}</a>;
  }
  if (kind === 'recipe') return <CookThisButton label={t.cookThis} />;
  if (kind === 'prompt' && hubText) {
    return <div {...{ [ACTION_ATTRIBUTE]: '' }}><CopyTextButton text={hubText} label={t.copyPrompt} copied={t.copied} failed={t.copyFailed}
      size="lg" className="rounded-full" /></div>;
  }
  if (kind === 'skill' && hubText) {
    return <div {...{ [ACTION_ATTRIBUTE]: '' }}><CopyTextButton text={hubText} label={t.copySkill} copied={t.copied}
      failed={t.copyFailed} size="lg" className="rounded-full" /></div>;
  }
  return null;
}
