import React from "react";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

export type ToastTone = "info" | "success" | "error";

export interface ToastMessage {
  id: number;
  text: string;
  tone: ToastTone;
}

interface ToastHostProps {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}

export const ToastHost: React.FC<ToastHostProps> = ({ toasts, onDismiss }) => {
  return (
    <div
      className="pointer-events-none fixed right-5 bottom-5 z-50 flex max-w-sm flex-col items-end gap-2"
      aria-live="polite"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const dot =
            toast.tone === "error" ? "bg-drop" : toast.tone === "success" ? "bg-keep" : "bg-ink-3";

          return (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              className="pointer-events-auto flex items-center gap-2.5 rounded-xl bg-overlay py-2 pr-1.5 pl-3.5 text-[13px] text-ink shadow-float"
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
              <span className="leading-snug">{toast.text}</span>
              <button
                type="button"
                onClick={() => onDismiss(toast.id)}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-white/[0.08] hover:text-ink"
                aria-label="Dismiss notification"
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
};
