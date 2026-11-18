import { useMemo, useState } from "react";

import { useI18n } from "../shell/i18n";
import { moveSelection } from "./content-form";

export interface PickerItem {
  id: string;
  name: string;
  /** Secondary text (style code, status). */
  meta?: string | null;
}

const VISIBLE_RESULTS = 40;

// Searchable multi-select over catalog items, laid out side by side for the POS's wide screen: matches
// on the left, the current selection on the right. When `ordered`, the selection order is the display
// order on the website and each pick can be moved up/down or removed. Picking is local form state only.
export function ItemPicker({
  label,
  items,
  selected,
  onChange,
  ordered = false,
  max,
  error,
  disabled = false,
  testId,
}: {
  label: string;
  items: readonly PickerItem[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  ordered?: boolean;
  max?: number;
  error?: string | null;
  disabled?: boolean;
  testId: string;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const matches = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return items
      .filter(
        (item) =>
          !term ||
          item.name.toLocaleLowerCase().includes(term) ||
          (item.meta ?? "").toLocaleLowerCase().includes(term),
      )
      .slice(0, VISIBLE_RESULTS);
  }, [items, search]);
  const full = max !== undefined && selected.length >= max;

  const toggle = (id: string, checked: boolean) => {
    if (checked) {
      if (!selected.includes(id) && !full) onChange([...selected, id]);
    } else {
      onChange(selected.filter((value) => value !== id));
    }
  };

  return (
    <div className="website-picker" data-testid={testId}>
      <div className="website-picker__pane">
        <label className="field">
          {label}
          <input
            type="search"
            value={search}
            placeholder={t("website.picker.search")}
            disabled={disabled}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <ul className="website-picker__list" aria-label={label}>
          {matches.map((item) => {
            const checked = selected.includes(item.id);
            return (
              <li key={item.id}>
                <label className="website-picker__option">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || (!checked && full)}
                    onChange={(event) => toggle(item.id, event.target.checked)}
                  />
                  <span>{item.name}</span>
                  {item.meta ? <small className="muted">{item.meta}</small> : null}
                </label>
              </li>
            );
          })}
          {matches.length === 0 ? (
            <li className="staff-empty">{t("website.picker.none")}</li>
          ) : null}
        </ul>
      </div>
      <div className="website-picker__pane">
        <p className="field__label">
          {max !== undefined
            ? t("website.picker.selectedMax", { count: selected.length, max })
            : t("website.picker.selected", { count: selected.length })}
        </p>
        {selected.length === 0 ? (
          <p className="staff-empty">{t("website.picker.empty")}</p>
        ) : (
          <ol className="website-picker__selected">
            {selected.map((id, index) => (
              <li key={id}>
                <span>{byId.get(id)?.name ?? t("website.picker.missing")}</span>
                <span className="website-picker__actions">
                  {ordered ? (
                    <>
                      <button
                        type="button"
                        className="link"
                        aria-label={t("website.picker.up")}
                        disabled={disabled || index === 0}
                        onClick={() => onChange(moveSelection(selected, index, -1))}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="link"
                        aria-label={t("website.picker.down")}
                        disabled={disabled || index === selected.length - 1}
                        onClick={() => onChange(moveSelection(selected, index, 1))}
                      >
                        ↓
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="link link--danger"
                    aria-label={t("website.picker.remove")}
                    disabled={disabled}
                    onClick={() => toggle(id, false)}
                  >
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}
        {error ? (
          <p className="website-field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
