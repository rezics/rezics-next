import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../shadcn/select.tsx';
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
    <Select
      value={value}
      items={options}
      onValueChange={(next) => {
        const selected = options.find((option) => option.value === next);
        if (selected) onValueChange(selected.value);
      }}
    >
      <SelectTrigger
        aria-label={label}
        data-slot="layout-select"
        className={cn('min-h-11 min-w-0 max-w-full sm:min-h-8', className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false}>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              data-layout-option={option.value}
              className={option.className}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
