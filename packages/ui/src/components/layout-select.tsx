import { NativeSelect, NativeSelectOption } from '../shadcn/native-select.tsx';
import { cn } from '../utils.ts';

export function LayoutSelect<Layout extends string>({
  label,
  value,
  options,
  onValueChange,
  className,
}: {
  label: string;
  value: Layout;
  options: readonly { value: Layout; label: string; className?: string }[];
  onValueChange: (value: Layout) => void;
  className?: string;
}) {
  return (
    <NativeSelect
      aria-label={label}
      data-slot="layout-select"
      value={value}
      className={cn('min-w-0 max-w-full [&>select]:min-h-11 sm:[&>select]:min-h-8', className)}
      onChange={(event) => {
        const selected = options.find((option) => option.value === event.currentTarget.value);
        if (selected) onValueChange(selected.value);
      }}
    >
      {options.map((option) => (
        <NativeSelectOption key={option.value} value={option.value} className={option.className}>
          {option.label}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}
