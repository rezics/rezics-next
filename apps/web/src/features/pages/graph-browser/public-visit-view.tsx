import { cn } from '@rezics/ui/utils';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import { graphGlobalVisitHref, graphPublicVisitUnsupported, type GraphPublicVisit } from './public-visit';

export function GraphPublicVisitNotice({
  locale,
  path,
  visit,
}: {
  locale: string;
  path: string;
  visit: GraphPublicVisit;
}) {
  const options = { locale: locale as never };
  const unsupported = graphPublicVisitUnsupported(visit);
  const returnHref = visit.kind === 'origin' ? visit.origin.returnHref : undefined;
  return (
    <section role="status" className="mx-auto w-full min-w-0 max-w-4xl space-y-3 [overflow-wrap:anywhere] rounded-md border p-4">
      <p className="text-sm text-muted-foreground">
        {unsupported ? m.graph_public_unsupported({}, options) : m.graph_public_invalid({}, options)}
      </p>
      {unsupported && returnHref && (
        <div className="flex flex-wrap gap-2">
          <a className={cn(buttonVariants({ variant: 'outline' }), 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 text-start [overflow-wrap:anywhere]')} href={returnHref}>
            {m.graph_public_return({}, options)}
          </a>
          <a
            className={cn(buttonVariants({ variant: 'default' }), 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 text-start [overflow-wrap:anywhere]')}
            href={graphGlobalVisitHref(path, returnHref)}
          >
            {m.graph_public_fresh_global({}, options)}
          </a>
        </div>
      )}
    </section>
  );
}
