import "@fontsource-variable/geist";
import "./styles.css";

import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root mount element");
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
