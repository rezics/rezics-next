import { cn } from 'cn';

/** Native checkbox for forms that must remain usable before hydration. */
export function NativeCheckbox({ className, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type="checkbox"
      className={cn(
        'relative size-4 shrink-0 appearance-none rounded-[5px] border border-transparent bg-input/90 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 checked:border-primary checked:bg-primary checked:after:absolute checked:after:top-[1px] checked:after:left-[5px] checked:after:h-2 checked:after:w-1 checked:after:rotate-45 checked:after:border-r-2 checked:after:border-b-2 checked:after:border-primary-foreground',
        className,
      )}
      {...props}
    />
  );
}
