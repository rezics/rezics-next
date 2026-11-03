import { Button } from '@rezics/ui/shadcn/button';
import type { ComponentProps } from 'react';

export const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full shrink px-3 py-2 leading-snug whitespace-normal [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

export function ExportAction(props: ComponentProps<typeof Button>) {
  return <Button size="lg" className={actionClass} {...props} />;
}
