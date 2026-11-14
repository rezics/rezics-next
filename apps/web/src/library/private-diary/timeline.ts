/** Adjacent date groups preserve every native occurrence, including repeated identities and sparse windows. */
export function chronologicalGroups<Row>(rows: readonly Row[], timestamp: (row: Row) => string) {
  const groups: { date: string; offset: number; rows: Row[] }[] = [];
  rows.forEach((row, offset) => {
    const date = timestamp(row).slice(0, 10);
    const previous = groups.at(-1);
    if (previous?.date === date) previous.rows.push(row);
    else groups.push({ date, offset, rows: [row] });
  });
  return groups;
}

/** Recorded history uses UTC calendar days; reported journal dates keep their independent native precision. */
export function recordedDayLabel(date: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}
