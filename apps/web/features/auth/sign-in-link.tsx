'use client';

import { buttonVariants } from '@rezics/ui/button';
import { usePathname, useSearchParams } from 'next/navigation';
import { signInPath } from './paths.ts';

/** The shell's account slot while signed out; sign-in returns to this page. */
export function SignInLink({ label }: { label: string }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const here = `${pathname}${search ? `?${search}` : ''}`;
  return <a href={pathname.startsWith('/sign-in') ? '/sign-in' : signInPath(here)}
    className={buttonVariants({ size: 'sm', pill: true })}>{label}</a>;
}
