import { Button } from '@rezics/ui/shadcn/button';
import { Spinner } from '@rezics/ui/shadcn/spinner';
import { cn } from '@rezics/ui/utils';
import { useSyncExternalStore, type ComponentProps } from 'react';

const subscribe = () => () => {};
export function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

type AuthButtonProps = Omit<ComponentProps<typeof Button>, 'className'> & { className?: string };

export function AuthButton({ children, disabled, type = 'button', className, ...props }: AuthButtonProps) {
  const hydrated = useHydrated();
  return (
    <Button
      {...props}
      type={type}
      disabled={disabled || (type === 'button' && !hydrated)}
      className={cn('h-auto min-h-11 min-w-0 max-w-full shrink whitespace-normal py-2', className)}
    >
      {props['aria-busy'] ? <Spinner aria-hidden="true" aria-label={undefined} role={undefined} /> : null}
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </Button>
  );
}
