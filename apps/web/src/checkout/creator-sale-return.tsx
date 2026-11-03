import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';

/** Closing only changes the mounted reading; the sales address and opaque cursor stay with browser history. */
export function CreatorSaleReturn({ close }: { close: () => void }) {
  return (
    <div className="space-y-2 border-t pt-4">
      <p className="text-sm text-muted-foreground">{m.creator_sale_return_hint()}</p>
      <Button className="min-h-11 whitespace-normal" variant="outline" onClick={close}>
        {m.creator_sale_close()}
      </Button>
    </div>
  );
}
