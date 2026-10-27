/** A localized shelf date; shadcn has no relative date display. */
export function RelativeTime({
  value,
  locale,
  now = new Date(),
  timeZone,
}: {
  value: string | Date;
  locale: string;
  now?: Date;
  timeZone?: string;
}) {
  const date = new Date(value);
  const parts = (d: Date) => {
    const values = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(d);
    const get = (type: string) => Number(values.find((part) => part.type === type)?.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'));
  };
  const days = Math.round((parts(date) - parts(now)) / 86_400_000);
  const text =
    days <= 0 && days > -7
      ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day')
      : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeZone }).format(date);
  return (
    <time
      dateTime={date.toISOString()}
      title={new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short', timeZone }).format(date)}
    >
      {text}
    </time>
  );
}
