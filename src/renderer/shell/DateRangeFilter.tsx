import { DatePicker } from "./DatePicker";
import { useI18n } from "./i18n";

// A single from→to date-range picker shared by every desk that scopes data to a period (Orders,
// Reports, Activity, Attendance). It groups two fully-themed DatePickers into one bordered control —
// with a direction arrow between them that flips under RTL — giving the calendar UI a consistent,
// palette-aware look app-wide. The `max`/`min` wiring keeps the range valid (you can never pick an
// end before the start). Labels default to the generic From/To but can be overridden per desk.
export function DateRangeFilter({
  from,
  to,
  onFromChange,
  onToChange,
  fromLabel,
  toLabel,
}: {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  fromLabel?: string;
  toLabel?: string;
}) {
  const { t } = useI18n();
  const resolvedFromLabel = fromLabel ?? t("activity.from");
  const resolvedToLabel = toLabel ?? t("activity.to");
  return (
    <div className="date-range" role="group" aria-label={t("activity.dateRange")}>
      <label className="date-range__field">
        <span>{resolvedFromLabel}</span>
        <DatePicker
          value={from}
          max={to || undefined}
          onChange={onFromChange}
          ariaLabel={resolvedFromLabel}
        />
      </label>
      <span className="date-range__sep" aria-hidden="true" />
      <label className="date-range__field">
        <span>{resolvedToLabel}</span>
        <DatePicker
          value={to}
          min={from || undefined}
          onChange={onToChange}
          ariaLabel={resolvedToLabel}
        />
      </label>
    </div>
  );
}
