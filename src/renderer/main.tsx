import React from "react";
import { ClerkProvider } from "@clerk/react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { clerkPublishableKey } from "./config";
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

const publishableKey = clerkPublishableKey();

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
            <main className="state-shell">
              <section className="state-card">
                <p className="eyebrow">Configuration required</p>
                <h1>Clerk is not configured</h1>
                <p>
                  Set VITE_CLERK_PUBLISHABLE_KEY to the public key for the operator Clerk instance.
                  Never place the Clerk secret key in this app.
                </p>
              </section>
            </main>
          )}
        </ToastProvider>
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
