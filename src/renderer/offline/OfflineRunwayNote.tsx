import { useEffect, useState } from "react";

import type { OfflineReadiness } from "../../shared/offline";
import { useI18n } from "../shell/i18n";
import { offlineRunway, runwayLabel } from "./runway";

/**
 * Inline "offline valid ~Nh/Nm" note, tinted when the runway is low. Shown both in the connected
 * sync strip and in the offline cashier so a PIN-only operator (who has no connected shell around
 * them) still sees how much offline runway remains before the grant must be topped up.
 */
export function OfflineRunwayNote({
  readiness,
}: {
  readiness: Extract<OfflineReadiness, { ready: true }>;
}) {
  const { t } = useI18n();
  // A ticking clock kept in state so the countdown stays live without calling the impure `Date.now()`
  // during render: lazily seeded once, then advanced only from inside the interval callback.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const runway = offlineRunway(readiness, now);
  if (!runway) return null;
  const label = runwayLabel(runway.millisRemaining);
  const text =
    label.kind === "expired"
      ? t("pos.offlineRunwayExpired")
      : label.kind === "hours"
        ? t("pos.offlineRunwayHours", { count: label.value })
        : t("pos.offlineRunwayMinutes", { count: label.value });
  return (
    <span
      className={`offline-runway${runway.low ? " offline-runway--low" : ""}`}
      title={runway.validUntil}
    >
      {` · ${text}`}
    </span>
  );
}
