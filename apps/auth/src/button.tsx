import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
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

type ButtonSize = NonNullable<ComponentProps<typeof Button>['size']>;
type ButtonVariant = NonNullable<ComponentProps<typeof Button>['variant']>;

const wrapMinHeight: Record<ButtonSize, string> = {
  default: 'min-h-7',
  xs: 'min-h-5',
  sm: 'min-h-6',
  lg: 'min-h-8',
  icon: '',
  'icon-xs': '',
  'icon-sm': '',
  'icon-lg': '',
};

/** Official Mira size, with room for wrapped labels. Icon sizes stay on their size prop. */
export function authControlClass(size: ButtonSize = 'default', className?: string) {
  const icon = size.startsWith('icon');
  return cn(icon ? null : 'h-auto min-w-0 max-w-full shrink whitespace-normal', wrapMinHeight[size], className);
}

type AuthButtonProps = Omit<ComponentProps<typeof Button>, 'className'> & { className?: string };

export function AuthButton({ children, disabled, type = 'button', className, size, ...props }: AuthButtonProps) {
  const hydrated = useHydrated();
  const resolved = size ?? 'default';
  const icon = resolved.startsWith('icon');
  return (
    <Button
      {...props}
      size={size}
      type={type}
      disabled={disabled || (type === 'button' && !hydrated)}
      className={authControlClass(resolved, className)}
    >
      {props['aria-busy'] ? <Spinner aria-hidden="true" aria-label={undefined} role={undefined} /> : null}
      {icon ? children : <span className="min-w-0 wrap-anywhere">{children}</span>}
    </Button>
  );
}

export function authLinkClass(variant: ButtonVariant = 'outline', className?: string) {
  return cn(buttonVariants({ variant, size: 'default' }), authControlClass('default', className));
}
