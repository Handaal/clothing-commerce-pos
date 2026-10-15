import { useT } from "./i18n";
import { Icons } from "./icons";
import type { SectionDef } from "./sections";

// Scaffold body for sections not yet built. Shows the localized section name, its purpose, and a
// clear "coming soon" marker so the full navigation is explorable while each section is filled in.
export function PlaceholderSection({ section }: { section: SectionDef }) {
  const t = useT();
  const Icon = Icons[section.icon];
  return (
    <div className="placeholder">
      <div className="placeholder__card">
        <div className="placeholder__icon" aria-hidden="true">
          <Icon />
        </div>
        <p className="eyebrow">{t("section.comingSoon")}</p>
        <h2>{t(section.labelKey)}</h2>
        <p className="placeholder__desc">{t(`section.${section.id}.desc`)}</p>
      </div>
    </div>
  );
}
