'use client';

import { Button, buttonVariants } from '@rezics/ui/button';
import { CookingPotIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { CopyTextButton } from '../../catalogue/copy-button.tsx';
import type { StatusWords } from '../../catalogue/reader-actions.tsx';
import type { UiLocale } from '../../../i18n/define.ts';
import type { WorkPageMessages } from '../messages.ts';
import type { ExperienceKind } from '../../entity-page/experience.ts';
import { ACTION_ATTRIBUTE } from '../hub.ts';
import { idOf, tabOf, type WorkAt } from '../route.ts';
import { WorkTaskLink } from '../work-nav.tsx';

/** Opens cooking mode on the recipe already on this page. */
export function CookThisButton({ label, workRef }: { label: string; workRef: WorkAt }) {
  const current = tabOf(usePathname(), workRef);
  if (current !== 'overview') return <WorkTaskLink workRef={workRef} anchor="cook"
    className={buttonVariants({ size: 'lg', pill: true })}><CookingPotIcon aria-hidden="true" />{label}</WorkTaskLink>;
  return <Button type="button" size="lg" pill {...{ [ACTION_ATTRIBUTE]: '' }} onClick={() => {
    document.getElementById('recipe-experience')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.dispatchEvent(new Event('rezics-cook'));
  }}><CookingPotIcon aria-hidden="true" />{label}</Button>;
}

/**
 * The header action for the page the reader is already on: cook a recipe,
 * copy the published prompt or skill. A book keeps Read, drawn by the frame.
 */
export function WorkKindActions({ kind, workId, workRef = idOf(workId) ?? workId, messages: t, hubText }: {
  kind: ExperienceKind; workId: string; title: string; locale: UiLocale; messages: WorkPageMessages;
  workRef?: WorkAt;
  /** The shelf words in the Work's own verb (`shelfWords`); the reading words when left out. */
  words?: StatusWords;
  /** Published prompt or SKILL.md, when the header can copy it. */
  hubText?: string | null;
}) {
  if (kind === 'book') return null;
  if (kind === 'guide') {
    return <WorkTaskLink workRef={workRef} anchor="guide-experience"
      className={buttonVariants({ size: 'lg', pill: true })}>{t.viewGuide}</WorkTaskLink>;
  }
  if (kind === 'recipe') return <CookThisButton label={t.cookThis} workRef={workRef} />;
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
