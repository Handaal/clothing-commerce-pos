import type { ReactNode } from "react";

import { useI18n, useT } from "./i18n";
import { Icons } from "./icons";
import type { SectionDef, SectionId } from "./sections";
import { useTheme } from "./theme";

interface AppShellProps {
  sections: readonly SectionDef[];
  active: SectionId;
  onNavigate: (id: SectionId) => void;
  userName: string;
  onSignOut: () => void;
  signOutDisabled?: boolean;
  children: ReactNode;
}

export function AppShell({
  sections,
  active,
  onNavigate,
  userName,
  onSignOut,
  signOutDisabled = false,
  children,
}: AppShellProps) {
  const t = useT();
  const { toggleLang } = useI18n();
  const { theme, toggle: toggleTheme } = useTheme();
  const initial = userName.trim().slice(0, 1).toUpperCase() || "?";

  return (
    <div className="shell">
      <aside className="shell-sidebar">
        <div className="shell-brand">
          <div className="shell-brand__mark" aria-hidden="true">
            {t("app.name").slice(0, 1)}
          </div>
          <div className="shell-brand__text">
            <strong>{t("app.name")}</strong>
            <span>{t("app.tagline")}</span>
          </div>
        </div>

        <nav className="shell-nav" aria-label={t("app.name")}>
          {sections.map((section) => {
            const Icon = Icons[section.icon];
            const isActive = section.id === active;
            return (
              <button
                key={section.id}
                type="button"
                className={`shell-nav__item${isActive ? " shell-nav__item--active" : ""}`}
                aria-current={isActive ? "page" : undefined}
                onClick={() => onNavigate(section.id)}
              >
                <Icon />
                <span>{t(section.labelKey)}</span>
              </button>
            );
          })}
        </nav>

        <button
          type="button"
          className="shell-nav__item shell-nav__signout"
          onClick={onSignOut}
          disabled={signOutDisabled}
        >
          <Icons.logout />
          <span>{t("nav.signOut")}</span>
        </button>
      </aside>

      <div className="shell-main">
        <header className="shell-header">
          <div className="shell-header__actions">
            <button
              type="button"
              className="icon-button"
              onClick={toggleTheme}
              title={theme === "dark" ? t("chrome.theme.toLight") : t("chrome.theme.toDark")}
              aria-label={theme === "dark" ? t("chrome.theme.toLight") : t("chrome.theme.toDark")}
            >
              {theme === "dark" ? <Icons.sun /> : <Icons.moon />}
            </button>
            <button
              type="button"
              className="icon-button icon-button--wide"
              onClick={toggleLang}
              title={t("chrome.language")}
            >
              <Icons.globe />
              <span>{t("chrome.language")}</span>
            </button>
            <div className="shell-user">
              <span className="shell-user__avatar" aria-hidden="true">
                {initial}
              </span>
              <span className="shell-user__name">{userName}</span>
            </div>
          </div>
        </header>

        <main className="shell-content">{children}</main>
      </div>
    </div>
  );
}
