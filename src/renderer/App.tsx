import { useEffect, useState } from "react";

import { checkApiStatus, type ConnectionStatus } from "./api-status";

type DisplayStatus = "checking" | ConnectionStatus;

export function App() {
  const [connectionStatus, setConnectionStatus] = useState<DisplayStatus>("checking");

  useEffect(() => {
    let active = true;
    void checkApiStatus().then((status) => {
      if (active) setConnectionStatus(status);
    });
    return () => {
      active = false;
    };
  }, []);

  const label =
    connectionStatus === "checking"
      ? "Checking API…"
      : connectionStatus === "connected"
        ? "API Connected"
        : "API Unavailable";

  return (
    <main className="shell">
      <section className="card">
        <p className="eyebrow">Secure desktop shell</p>
        <h1>POS Desktop — Foundation Ready</h1>
        <p className={`status status--${connectionStatus}`}>
          <span aria-hidden="true" className="status__dot" />
          {label}
        </p>
        <p className="runtime">Electron {window.foundation.versions.electron}</p>
      </section>
    </main>
  );
}
