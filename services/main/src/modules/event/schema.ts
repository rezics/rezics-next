// Typed declarations for derived event interval keys and histograms (Access
// migration 112). The event-time-v1 profile owns Event occurrences and exact
// time revisions. Accepted topic-to-event facts reuse G-049 Statements and
// decision slots rather than an event-specific head. Adapters select date
// columns as ISO text, avoiding pg's local-time Date parsing.
import { declareTable } from '../recommendation/generation-schema.ts';

const EVENT_TIME_PRECISIONS = ['year', 'month', 'day', 'minute', 'second'] as const;
type EventTimePrecision = (typeof EVENT_TIME_PRECISIONS)[number];
type EventEndpointState = 'known' | 'unknown' | 'open';

export interface EventIntervalKeyRow {
  generation_id: string;
  family: 'event-interval';
  event: string;
  time_revision: string;
  time_status: 'actual' | 'planned';
  temporal_kind: 'instant' | 'interval';
  interpretation: 'civil-date' | 'instant';
  conversion_profile: string;
  start_state: EventEndpointState;
  start_precision: EventTimePrecision | null;
  end_state: EventEndpointState;
  end_precision: EventTimePrecision | null;
  civil_start_min: string | null;
  civil_start_max: string | null;
  civil_end_min: string | null;
  civil_end_max: string | null;
  instant_start_min: Date | null;
  instant_start_max: Date | null;
  instant_end_min: Date | null;
  instant_end_max: Date | null;
  /** Generated: any admissible reading may touch this span. */
  civil_possible: string | null;
  /** Generated: every admissible reading covers this span. */
  civil_definite: string | null;
  instant_possible: string | null;
  instant_definite: string | null;
}

export interface EventHistogramBucketRow {
  generation_id: string;
  family: 'event-interval';
  time_status: 'actual' | 'planned';
  grain: 'year' | 'month' | 'day';
  bucket_start: string;
  definite_count: string;
  possible_count: string;
}

export const eventTables = [
  declareTable<EventIntervalKeyRow>()('access', 'event_interval_key',
    ['generation_id', 'family', 'event', 'time_revision', 'time_status', 'temporal_kind', 'interpretation',
      'conversion_profile', 'start_state', 'start_precision', 'end_state', 'end_precision',
      'civil_start_min', 'civil_start_max', 'civil_end_min', 'civil_end_max',
      'instant_start_min', 'instant_start_max', 'instant_end_min', 'instant_end_max',
      'civil_possible', 'civil_definite', 'instant_possible', 'instant_definite']),
  declareTable<EventHistogramBucketRow>()('access', 'event_histogram_bucket',
    ['generation_id', 'family', 'time_status', 'grain', 'bucket_start', 'definite_count', 'possible_count']),
] as const;
