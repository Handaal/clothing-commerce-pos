import { useEffect, useRef, useState, type ReactNode } from "react";

import { useI18n, useT } from "./i18n";
import { Icons } from "./icons";
import { SECTION_GROUPS, type SectionDef, type SectionId } from "./sections";
import { useTheme } from "./theme";

interface AppShellProps {
  sections: readonly SectionDef[];
  active: SectionId;
  onNavigate: (id: SectionId) => void;
  userName: string;
  onSignOut: () => void;
  signOutDisabled?: boolean;
  /** Section-specific context shown at the start of the header row (e.g. the POS register + status). */
  headerStart?: ReactNode;
  /** Section-specific actions shown before the theme/language/user controls. */
  headerActions?: ReactNode;
  /** Work waiting in a section (e.g. website orders to ship), shown as a count on its nav item. */
  badges?: Partial<Record<SectionId, number>>;
  children: ReactNode;
}

export function AppShell({
  sections,
  active,
  onNavigate,
  userName,
  onSignOut,
  signOutDisabled = false,
  headerStart,
  headerActions,
  badges,
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
          {SECTION_GROUPS.map((group) => {
            const items = sections.filter((section) => section.group === group);
            if (items.length === 0) return null;
            return (
              <div className="shell-nav__group" key={group}>
                <p className="shell-nav__group-label">{t(`nav.group.${group}`)}</p>
                {items.map((section) => {
                  const Icon = Icons[section.icon];
                  const isActive = section.id === active;
                  const label = t(section.labelKey);
                  const badge = badges?.[section.id] ?? 0;
                  const badgeLabel =
                    badge > 0 ? t("nav.waitingCount", { label, count: badge }) : label;
                  return (
                    <button
                      key={section.id}
                      type="button"
                      className={`shell-nav__item${isActive ? " shell-nav__item--active" : ""}`}
                      aria-current={isActive ? "page" : undefined}
                      aria-label={badgeLabel}
                      // The sidebar collapses to icons on smaller tills; the tooltip keeps the name.
                      title={badgeLabel}
                      onClick={() => onNavigate(section.id)}
                    >
                      <Icon />
                      <span>{label}</span>
                      {badge > 0 ? (
                        <span className="shell-nav__badge" aria-hidden="true">
                          {badge > 99 ? "99+" : badge}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <button
          type="button"
          className="shell-nav__item shell-nav__signout"
          onClick={onSignOut}
          disabled={signOutDisabled}
          title={t("nav.signOut")}
        >
          <Icons.logout />
          <span>{t("nav.signOut")}</span>
        </button>
      </aside>

      <div className="shell-main">
        <header className="shell-header">
          {headerStart ? <div className="shell-header__start">{headerStart}</div> : null}
          <div className="shell-header__actions">
            {headerActions ? (
              <div className="shell-header__section-actions">{headerActions}</div>
            ) : null}
            <UserMenu
              userName={userName}
              initial={initial}
              themeLabel={theme === "dark" ? t("chrome.theme.toLight") : t("chrome.theme.toDark")}
              themeIcon={theme === "dark" ? <Icons.sun /> : <Icons.moon />}
              onToggleTheme={toggleTheme}
              languageLabel={t("chrome.language")}
              onToggleLanguage={toggleLang}
              signOutLabel={t("nav.signOut")}
              onSignOut={onSignOut}
              signOutDisabled={signOutDisabled}
              menuLabel={t("chrome.userMenu")}
            />
          </div>
        </header>

        <main className="shell-content">{children}</main>
      </div>
    </div>
  );
}

/**
 * The operator chip in the header opens a small menu with the per-machine preferences (theme,
 * language) and sign-out, so these rarely-used controls do not compete with the till's actions.
 */
function UserMenu({
  userName,
  initial,
  themeLabel,
  themeIcon,
  onToggleTheme,
  languageLabel,
  onToggleLanguage,
  signOutLabel,
  onSignOut,
  signOutDisabled,
  menuLabel,
}: {
  userName: string;
  initial: string;
  themeLabel: string;
  themeIcon: ReactNode;
  onToggleTheme: () => void;
  languageLabel: string;
  onToggleLanguage: () => void;
  signOutLabel: string;
  onSignOut: () => void;
  signOutDisabled: boolean;
  menuLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div className={`shell-user-menu${open ? " shell-user-menu--open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="shell-user"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={menuLabel}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="shell-user__avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="shell-user__name">{userName}</span>
        <Icons.chevronDown />
      </button>
      {open ? (
        <div className="shell-user-menu__list" role="menu">
          <button type="button" role="menuitem" onClick={run(onToggleTheme)}>
            {themeIcon}
            <span>{themeLabel}</span>
          </button>
          <button type="button" role="menuitem" onClick={run(onToggleLanguage)}>
            <Icons.globe />
            <span>{languageLabel}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="shell-user-menu__danger"
            disabled={signOutDisabled}
            onClick={run(onSignOut)}
          >
            <Icons.logout />
            <span>{signOutLabel}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
