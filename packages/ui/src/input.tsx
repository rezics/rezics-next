import { ark } from '@ark-ui/react/factory';
import type React from 'react';
import { cn } from './utils.ts';

export function Input({ className, ...props }: React.ComponentProps<typeof ark.input>) {
  return <ark.input {...props} className={cn('min-h-11 w-full rounded-[3px] border border-slate-300 bg-white px-3 text-[16px] text-slate-900 outline-none placeholder:text-slate-500 focus-visible:border-blue-700 focus-visible:ring-[3px] focus-visible:ring-blue-200 disabled:opacity-50', className)} />;
}
