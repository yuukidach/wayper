import "@fontsource-variable/geist";
import "./styles.css";

import React from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { App } from "./App";
import { motionTransition } from "./lib/motion";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root mount element");
}

createRoot(container).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user" transition={motionTransition.normal}>
      <App />
    </MotionConfig>
  </React.StrictMode>,
);
