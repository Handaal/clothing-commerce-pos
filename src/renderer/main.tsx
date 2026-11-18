import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { I18nProvider } from "./shell/i18n";
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

// ADR-043: the POS has no Clerk provider, key or session. It boots straight to its POS-native floor login.
createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
