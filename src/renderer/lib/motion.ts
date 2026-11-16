import type { Transition } from "motion/react";
import type { CSSProperties } from "react";

export const motionDuration = {
  fast: 0.16,
  normal: 0.24,
  reveal: 0.32,
  ambient: 0.5,
} as const;

export const motionEase = [0.22, 1, 0.36, 1] as const;
export const motionEasing = "cubic-bezier(0.22, 1, 0.36, 1)";

export const motionCssVariables = {
  "--motion-fast": `${motionDuration.fast * 1000}ms`,
  "--motion-normal": `${motionDuration.normal * 1000}ms`,
  "--motion-reveal": `${motionDuration.reveal * 1000}ms`,
} as CSSProperties;

export const motionTransition = {
  fast: { duration: motionDuration.fast, ease: motionEase },
  normal: { duration: motionDuration.normal, ease: motionEase },
  reveal: { duration: motionDuration.reveal, ease: motionEase },
  ambient: { duration: motionDuration.ambient, ease: "linear" },
  select: { type: "spring", stiffness: 520, damping: 40, mass: 0.7 },
} satisfies Record<string, Transition>;

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function scrollMotion(): ScrollBehavior {
  return prefersReducedMotion() ? "instant" : "smooth";
}
