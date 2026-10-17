import React from "react";
import { ClerkProvider } from "@clerk/react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { clerkPublishableKey } from "./config";
import { I18nProvider, useT } from "./shell/i18n";
import { ThemeProvider } from "./shell/theme";
import { ToastProvider } from "./shell/Toast";
// Self-hosted variable fonts (bundled, so the POS keeps its identity fully offline):
// Fraunces = editorial serif display, Plus Jakarta Sans = UI text, Cairo = Arabic text.
import "@fontsource-variable/fraunces";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/cairo";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root element was not found");

const publishableKey = clerkPublishableKey();

// Rendered inside the i18n provider when the Clerk key is missing, so it is localized like the rest
// of the app. This is an operator/setup error, not a normal state.
function ClerkNotConfigured() {
  const t = useT();
  return (
    <main className="state-shell">
      <section className="state-card">
        <p className="eyebrow">{t("boot.configRequired")}</p>
        <h1>{t("boot.clerkMissing")}</h1>
        <p>{t("boot.clerkMissingBody")}</p>
      </section>
    </main>
  );
}

createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          {publishableKey ? (
            <ClerkProvider publishableKey={publishableKey}>
              <App />
            </ClerkProvider>
          ) : (
            <ClerkNotConfigured />
          )}
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
