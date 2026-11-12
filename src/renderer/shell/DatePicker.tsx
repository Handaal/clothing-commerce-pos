import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { useI18n } from "./i18n";

// A fully themed, accessible date picker that replaces the native <input type="date">. The native
// calendar popup is OS/Chromium-rendered and only honours light/dark (color-scheme) — it can never
// take the palette accent. This renders its own calendar grid from the design tokens, so the whole
// control (trigger, popover, selected day, today marker) follows the active theme AND palette, in
// both LTR and RTL. The value in/out is an ISO `YYYY-MM-DD` string (or ""), identical to the native
// input it supersedes, so every call site stays unchanged.

// Parse an ISO date as a *local* calendar day (new Date("YYYY-MM-DD") would parse as UTC midnight and
// shift the day in negative-offset timezones). Returns null for empty/invalid input.
function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

// Min/max are inclusive ISO bounds. ISO `YYYY-MM-DD` strings sort lexicographically, so string
// comparison is a correct (and cheap) day comparison.
function clampIso(iso: string, min?: string, max?: string): string {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

function isDisabled(iso: string, min?: string, max?: string): boolean {
  return (!!min && iso < min) || (!!max && iso > max);
}

// First weekday of the week for the locale, as a Sunday-based index (0=Sun … 6=Sat). Uses the
// Intl week-info API where available (Chromium has it) and falls back to Saturday for Arabic.
function firstWeekday(locale: string): number {
  try {
    const localeObj = new Intl.Locale(locale) as Intl.Locale & {
      weekInfo?: { firstDay?: number };
      getWeekInfo?: () => { firstDay?: number };
    };
    const info = localeObj.getWeekInfo?.() ?? localeObj.weekInfo;
    const firstDay = info?.firstDay; // 1=Mon … 7=Sun
    if (firstDay) return firstDay === 7 ? 0 : firstDay;
  } catch {
    // Older engines: fall through to the heuristic below.
  }
  return locale.startsWith("ar") ? 6 : 0;
}

export interface DatePickerProps {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
}

export function DatePicker({
  value,
  onChange,
  min,
  max,
  id,
  ariaLabel,
  placeholder,
  className,
}: DatePickerProps) {
  const { t, locale } = useI18n();
  const isRtl = locale.startsWith("ar");

  const [open, setOpen] = useState(false);
  // When the trigger sits near the viewport's inline-end edge, a start-anchored popover would spill its
  // last column off-screen (forcing a horizontal scroll). Flip it to end-anchored so it opens inward.
  const [alignEnd, setAlignEnd] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();

  const today = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);
  const todayIso = toIso(today);

  const selected = parseIso(value);
  // The month shown in the popover, and the roving-focus day inside the grid.
  const [view, setView] = useState<Date>(() => startOfMonth(selected ?? today));
  const [focusIso, setFocusIso] = useState<string>(() => clampIso(value || todayIso, min, max));

  const close = useCallback(() => setOpen(false), []);
  const closeToTrigger = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const openPicker = useCallback(() => {
    const base = parseIso(value) ?? today;
    setView(startOfMonth(base));
    setFocusIso(clampIso(value || todayIso, min, max));
    // Decide alignment from the trigger's position before the popover paints. The popover is ~17rem
    // wide (272px at 16px root); keep an 8px viewport margin. In RTL the inline-start edge is the right.
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const popoverWidth = 272;
      const spill = isRtl
        ? rect.right - popoverWidth < 8
        : rect.left + popoverWidth > window.innerWidth - 8;
      setAlignEnd(spill);
    }
    setOpen(true);
  }, [value, today, todayIso, min, max, isRtl]);

  const selectDay = useCallback(
    (iso: string) => {
      if (isDisabled(iso, min, max)) return;
      onChange(iso);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange, min, max],
  );

  // Close on outside click, mirroring the Select component's behaviour.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // Roving tabindex: move DOM focus onto the focused day whenever it changes while open.
  useEffect(() => {
    if (!open) return;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${focusIso}"]`)?.focus();
  }, [open, focusIso]);

  const monthLabel = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(view),
    [locale, view],
  );
  const fdow = useMemo(() => firstWeekday(locale), [locale]);
  const weekdayLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    const sunday = new Date(2023, 0, 1); // 1 Jan 2023 was a Sunday.
    return Array.from({ length: 7 }, (_, i) => fmt.format(addDays(sunday, (fdow + i) % 7)));
  }, [locale, fdow]);

  // 42 cells (6 weeks) covering the visible month plus leading/trailing days of its neighbours.
  const cells = useMemo(() => {
    const first = startOfMonth(view);
    const lead = (first.getDay() - fdow + 7) % 7;
    const gridStart = addDays(first, -lead);
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [view, fdow]);

  const dayNumber = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const displayValue = selected
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(selected)
    : (placeholder ?? t("datepicker.placeholder"));

  const stepMonth = useCallback((delta: number) => {
    setView((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  }, []);

  const moveFocus = useCallback(
    (nextDate: Date) => {
      const clamped = clampIso(toIso(nextDate), min, max);
      setFocusIso(clamped);
      const parsed = parseIso(clamped);
      if (
        parsed &&
        (parsed.getMonth() !== view.getMonth() || parsed.getFullYear() !== view.getFullYear())
      )
        setView(startOfMonth(parsed));
    },
    [min, max, view],
  );

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = parseIso(focusIso) ?? today;
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        moveFocus(addDays(current, isRtl ? 1 : -1));
        break;
      case "ArrowRight":
        event.preventDefault();
        moveFocus(addDays(current, isRtl ? -1 : 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(addDays(current, -7));
        break;
      case "ArrowDown":
        event.preventDefault();
        moveFocus(addDays(current, 7));
        break;
      case "Home":
        event.preventDefault();
        moveFocus(addDays(current, -((current.getDay() - fdow + 7) % 7)));
        break;
      case "End":
        event.preventDefault();
        moveFocus(addDays(current, 6 - ((current.getDay() - fdow + 7) % 7)));
        break;
      case "PageUp":
        event.preventDefault();
        moveFocus(new Date(current.getFullYear(), current.getMonth() - 1, current.getDate()));
        break;
      case "PageDown":
        event.preventDefault();
        moveFocus(new Date(current.getFullYear(), current.getMonth() + 1, current.getDate()));
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        selectDay(focusIso);
        break;
      case "Escape":
        event.preventDefault();
        closeToTrigger();
        break;
    }
  };

  return (
    <div
      className={`datepicker${open ? " datepicker--open" : ""}${className ? ` ${className}` : ""}`}
      ref={rootRef}
    >
      <button
        type="button"
        id={id}
        ref={triggerRef}
        className="datepicker__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openPicker())}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            openPicker();
          }
        }}
      >
        <span className={`datepicker__value${selected ? "" : " datepicker__value--placeholder"}`}>
          {displayValue}
        </span>
        <span className="datepicker__icon" aria-hidden="true" />
      </button>

      {open ? (
        <div
          className={`datepicker__popover${alignEnd ? " datepicker__popover--end" : ""}`}
          role="dialog"
          aria-modal="false"
          aria-label={monthLabel}
          id={dialogId}
        >
          <div className="datepicker__nav">
            <button
              type="button"
              className="datepicker__navbtn datepicker__navbtn--prev"
              aria-label={t("datepicker.prevMonth")}
              onClick={() => stepMonth(-1)}
            >
              <span className="datepicker__chevron" aria-hidden="true" />
            </button>
            <strong className="datepicker__month" aria-live="polite">
              {monthLabel}
            </strong>
            <button
              type="button"
              className="datepicker__navbtn datepicker__navbtn--next"
              aria-label={t("datepicker.nextMonth")}
              onClick={() => stepMonth(1)}
            >
              <span className="datepicker__chevron" aria-hidden="true" />
            </button>
          </div>

          <div className="datepicker__weekdays" aria-hidden="true">
            {weekdayLabels.map((label, index) => (
              <span key={index} className="datepicker__weekday">
                {label}
              </span>
            ))}
          </div>

          <div className="datepicker__grid" role="grid" ref={gridRef} onKeyDown={onGridKeyDown}>
            {cells.map((date) => {
              const iso = toIso(date);
              const disabled = isDisabled(iso, min, max);
              const outside = date.getMonth() !== view.getMonth();
              const isSelected = iso === value;
              const isToday = iso === todayIso;
              return (
                <button
                  key={iso}
                  type="button"
                  role="gridcell"
                  data-iso={iso}
                  tabIndex={iso === focusIso ? 0 : -1}
                  disabled={disabled}
                  aria-selected={isSelected}
                  aria-current={isToday ? "date" : undefined}
                  className={
                    "datepicker__day" +
                    (outside ? " datepicker__day--outside" : "") +
                    (isSelected ? " datepicker__day--selected" : "") +
                    (isToday ? " datepicker__day--today" : "")
                  }
                  onClick={() => selectDay(iso)}
                >
                  {dayNumber.format(date.getDate())}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
