import { Button } from '@rezics/ui/shadcn/button';
import type { ComponentProps } from 'react';

export const actionClass = 'h-auto min-h-7 max-w-full shrink whitespace-normal [overflow-wrap:anywhere]';

export function ExportAction(props: ComponentProps<typeof Button>) {
  return <Button className={actionClass} {...props} />;
}
