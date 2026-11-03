import React from "react";
import { createRoot } from "react-dom/client";
import { Panel } from "./panel";
import "./styles.css";
import "../../../shared/monitorSetup.css";

// Mount only. Keeping this out of panel.tsx is what makes the panel importable by tests —
// a component module that mounts itself on import cannot be rendered in isolation.
const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("renderer root element is missing");
}

const rendererWindow = window as typeof window & { __rshPanelRoot?: ReturnType<typeof createRoot> };
const root = rendererWindow.__rshPanelRoot ?? createRoot(rootElement);
rendererWindow.__rshPanelRoot = root;
root.render(<Panel />);
