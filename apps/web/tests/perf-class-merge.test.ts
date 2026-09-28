import { expect, test } from 'bun:test';
import { cn } from '@rezics/ui/utils';

// cn now merges with tailwind-variants' bundled merger instead of tailwind-merge plus clsx (a page-weight fix);
// these are the clsx and tailwind-merge behaviours the components rely on.
test('cn joins class values as clsx did and lets the last conflicting Tailwind class win', () => {
  expect(cn('px-2', 'px-4')).toBe('px-4');
  expect(cn('px-4', 'p-2')).toBe('p-2');
  expect(cn('text-sm text-muted-foreground', 'text-lg text-foreground')).toBe('text-lg text-foreground');
  expect(cn('rounded-xl', { 'rounded-full': true, hidden: false })).toBe('rounded-full');
  expect(cn('@min-[4.5rem]:line-clamp-3', '@min-[4.5rem]:line-clamp-4')).toBe('@min-[4.5rem]:line-clamp-4');
  // Falsy values, including a zero count, add nothing; nested arrays flatten.
  expect(cn(undefined, null, false, 0, ['a', ['b']])).toBe('a b');
  expect(cn()).toBe('');
});
