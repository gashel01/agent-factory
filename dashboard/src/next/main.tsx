/** Entry point of the dashboard UI (served at /). */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initToken, initWs } from "../api.js";
import { ErrorBoundary } from "../error-boundary.js";
import { WardenProvider } from "./data.js";
import { App } from "./shell/App.js";

initToken();
initWs();
createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <ErrorBoundary name="Warden">
      <WardenProvider><App /></WardenProvider>
    </ErrorBoundary>
  </StrictMode>,
);
