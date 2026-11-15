/// <reference types="vite/client" />

import type { WayperBridge } from "../shared/types";

declare global {
  interface Window {
    wayper: WayperBridge;
  }
}

export {};
