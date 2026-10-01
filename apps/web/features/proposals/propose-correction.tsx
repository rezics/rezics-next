'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Button } from '@rezics/ui/button';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTrigger } from '@rezics/ui/dialog';
import { PencilLineIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { languagesOf, startLanguage } from './candidate.ts';
import { bffCreate, type CreateApi } from './commands.ts';
import { CorrectionEditor } from './correction-editor.tsx';
import type { ProposalMessages } from './messages.ts';
import type { CorrectionBasis, Loaded } from './types.ts';

interface Props {
  basis: Loaded<CorrectionBasis>;
  /** The session's Agent; null when nobody is signed in. */
  actingSubject: string | null;
  /** The reader's content languages, best first: the editor starts in the first the Work has. */
  languages: readonly string[];
  create?: CreateApi;
  /** Where a signed-out reader goes to sign in; the notice links to it when given. */
  signInHref?: string;
  locale: UiLocale;
  messages: ProposalMessages;
}

/** What opening a proposal does next: its page, where reviewers and the proposer follow it. */
function useOpened(locale: UiLocale) {
  const router = useRouter();
  return (proposal: string) => router.push(localizedPath(`/proposals/${proposal}`, locale));
}

function Editor({ basis, actingSubject, languages, create: givenCreate, signInHref, locale, messages, onCancel }:
  Props & { onCancel?: () => void }) {
  const t = materializeData(messages, { locale });
  const opened = useOpened(locale);
  const create = useMemo(() => givenCreate ?? (actingSubject ? bffCreate(actingSubject) : null), [givenCreate, actingSubject]);
  if (!actingSubject || !create) return <Alert variant="info"><AlertDescription className="text-foreground">
    {t.signInToPropose}{signInHref ? <> <a href={signInHref} className="font-medium text-primary underline underline-offset-2">
      {t.signInAction}</a></> : null}</AlertDescription></Alert>;
  if (!basis.ok) return <Alert variant="warning" role="alert"><AlertDescription className="text-foreground">
    {t.proposeUnavailable}</AlertDescription></Alert>;
  const { target, baseHeads, state, name } = basis.data;
  return <div className="grid gap-4">
    {name ? <p className="text-muted-foreground text-sm">{t.proposeFor({ name: name.value })}</p> : null}
    <CorrectionEditor state={state} languages={languagesOf(state, name?.language)} language={startLanguage(state, languages, name?.language ?? locale)}
      submitLabel={t.submitProposal} locale={locale} messages={messages}
      {...onCancel ? { onCancel } : {}}
      onSubmit={async (candidate, evidence, key) => {
        const outcome = await create({ kind: 'component-correction', target, candidate, baseHeads, evidence }, key);
        if (outcome.ok) opened(outcome.data.proposal);
        return outcome;
      }} />
  </div>;
}

/**
 * "Propose correction": a button that opens the correction form for a Work. A
 * host shows it where the viewer cannot edit directly; Main's review decides
 * everything after the proposal is opened, so this holds no eligibility rules.
 */
export function ProposeCorrection({ defaultOpen = false, ...props }: Props & { defaultOpen?: boolean }) {
  const t = materializeData(props.messages, { locale: props.locale });
  const [open, setOpen] = useState(defaultOpen);
  return <Dialog open={open} onOpenChange={details => setOpen(details.open)}>
    <DialogTrigger asChild><Button variant="outline"><PencilLineIcon aria-hidden="true" />{t.proposeAction}</Button>
    </DialogTrigger>
    <DialogContent size="lg">
      <DialogHeader title={t.proposeTitle} description={t.proposeDescription} />
      <DialogBody><Editor {...props} onCancel={() => setOpen(false)} /></DialogBody>
    </DialogContent>
  </Dialog>;
}

/** The same form as a page, for `/proposals/new?work=…`: a link any host can point at. */
export function ProposeCorrectionPage(props: Props) {
  return <Editor {...props} />;
}
