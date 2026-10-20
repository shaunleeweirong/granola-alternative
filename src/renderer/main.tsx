import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { AutoStopPanel } from "./components/AutoStopPanel.tsx";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");

// The auto-stop countdown has a window of its own, loaded from this same page.
const view = new URLSearchParams(window.location.search).get("view");
if (view === "auto-stop") document.body.classList.add("auto-stop-view");

createRoot(container).render(
  <StrictMode>{view === "auto-stop" ? <AutoStopPanel /> : <App />}</StrictMode>
);
