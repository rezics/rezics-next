import { ReadingDisclosureScope } from '@rezics/ui/cover';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import type { ProfileReading } from './adapter';

export const ProfileReadingResponse = ReadingDisclosureScope;

/** A stable trigger retains focus naturally; completion never focuses a reader who has moved elsewhere. */
export function ProfileReadingStatus({ reading, locale }: { reading: ProfileReading; locale: string }) {
  const options = { locale: locale as never };
  const text = {
    conservative: m.profile_reading_conservative,
    'signed-out': m.profile_reading_signed_out,
    loading: m.profile_reading_loading,
    ready: m.profile_reading_ready,
    unavailable: m.profile_reading_unavailable,
    rejected: m.profile_reading_rejected,
    closed: m.profile_reading_closed,
    preparing: m.profile_reading_preparing,
    retired: m.profile_reading_retired,
  }[reading.state]({}, options);
  return (
    <section data-slot="profile-reading" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="min-w-0 max-w-prose wrap-anywhere text-muted-foreground"
      >
        {text}
      </p>
      {reading.retry && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 max-w-full whitespace-normal text-start"
          aria-disabled={reading.state === 'loading'}
          onClick={() => {
            if (reading.state !== 'loading') reading.retry?.();
          }}
        >
          {m.profile_reading_retry({}, options)}
        </Button>
      )}
    </section>
  );
}
