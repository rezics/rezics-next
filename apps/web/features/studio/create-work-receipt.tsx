import { buttonVariants } from '@rezics/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@rezics/ui/card';
import { CircleCheckIcon } from 'lucide-react';
import type { StudioMessages } from './messages.ts';

export interface CreatedWork {
  title: string;
  receipt: {
    work: string; mainVersion: string; workRevision: string; mainRevision: string;
    sourcePosition: { datasetId: string; dataEpoch: string; sequence: string };
  };
}

/** The receipt Main returned for a new Work: the IDs a later edit needs. */
export function CreateWorkReceipt({ title, receipt, messages }: CreatedWork & { messages: StudioMessages }) {
  const ids = [[messages.work, receipt.work], [messages.mainVersion, receipt.mainVersion],
    [messages.revision, receipt.workRevision], [messages.sourceSequence, receipt.sourcePosition.sequence]];
  return <Card asChild><section role="status" aria-label={messages.createdStatus}>
    <CardHeader className="gap-3">
      <p className="flex items-center gap-2 font-semibold text-success-foreground">
        <CircleCheckIcon aria-hidden="true" className="size-5" />{messages.createdHeading}</p>
      <h2 className="break-words font-semibold font-work-title text-2xl">{title}</h2>
      <p className="text-muted-foreground text-sm">{messages.createdHelp}</p>
    </CardHeader>
    <CardContent>
      <dl className="grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-x-4">
        {ids.map(([term, value]) => <div key={term} className="contents">
          <dt className="text-muted-foreground text-sm">{term}</dt>
          <dd className="-mt-2 break-all font-mono text-[13px] sm:mt-0">{value}</dd>
        </div>)}
      </dl>
    </CardContent>
    <CardFooter>
      <a href="/studio" className={buttonVariants({ variant: 'outline' })}>{messages.createAnother}</a>
    </CardFooter>
  </section></Card>;
}
