import { buttonVariants } from '@rezics/ui/button';
import { PencilLineIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import type { WorkPageMessages } from './messages.ts';

/**
 * Where a Work's facts offer "Propose correction". It leads to the correction form for the Work
 * (`/proposals/new?work=…`, G-867's page); the proposal flow itself lives with the proposals feature, so a
 * host that wants the in-page dialog swaps this one component.
 */
export function ProposeCorrectionSlot({ work, locale, messages }: { work: string; locale: UiLocale;
  messages: WorkPageMessages }) {
  return <div><Link href={`/proposals/new?work=${work}`} className={buttonVariants({ variant: 'outline', size: 'sm', pill: true })}>
    <PencilLineIcon aria-hidden="true" />{materializeData(messages, { locale }).proposeCorrection}</Link></div>;
}
