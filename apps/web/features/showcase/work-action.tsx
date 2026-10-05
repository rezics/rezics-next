import { buttonVariants } from '@rezics/ui/button';
import type { ZoneWork } from '@rezics/zone-sdk';
import { BookOpenIcon, CookingPotIcon, DownloadIcon, Gamepad2Icon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { CopyTextButton } from '../catalogue/copy-button.tsx';
import { messages as catalogueMessages } from '../catalogue/messages.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import type { ZoneMessages } from '../zones/messages.ts';

/** Featured Works use the same verb as their catalogue action. */
export function PrimaryAction({
  work,
  locale,
  messages,
}: {
  work: ZoneWork;
  locale: UiLocale;
  messages: ZoneMessages;
}) {
  const t = catalogueMessages[locale];
  if (work.hub?.kind === 'prompt') {
    return (
      <CopyTextButton
        text={work.hub.copyText}
        label={t.copyPrompt}
        copied={t.promptCopied}
        failed={t.copyFailed}
      />
    );
  }
  const [Icon, label] =
    work.hub?.kind === 'skill' || work.kind === 'package'
      ? [DownloadIcon, t.install]
      : work.kind === 'recipe'
        ? [CookingPotIcon, t.openRecipe]
        : work.kind === 'game'
          ? [Gamepad2Icon, messages.play]
          : [BookOpenIcon, messages.read];
  return (
    <LocalizedLink href={work.href} className={buttonVariants({ size: 'sm', pill: true })}>
      <Icon aria-hidden="true" />
      {label}
    </LocalizedLink>
  );
}
