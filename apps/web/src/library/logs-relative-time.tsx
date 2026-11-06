import { getLocale } from '../paraglide/runtime.js';
import { fullDateTime } from '../threads/byline';

export function RelativeTime({ value }: { value: string }) {
  const locale = getLocale();
  const delta = new Date(value).getTime() - Date.now();
  const distance = Math.abs(delta);
  const [unit, size] =
    distance < 60_000
      ? (['second', 1_000] as const)
      : distance < 3_600_000
        ? (['minute', 60_000] as const)
        : distance < 86_400_000
          ? (['hour', 3_600_000] as const)
          : distance < 2_592_000_000
            ? (['day', 86_400_000] as const)
            : distance < 31_536_000_000
              ? (['month', 2_592_000_000] as const)
              : (['year', 31_536_000_000] as const);
  return (
    <time dateTime={value} title={fullDateTime(value, locale)}>
      {new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(delta / size), unit)}
    </time>
  );
}
