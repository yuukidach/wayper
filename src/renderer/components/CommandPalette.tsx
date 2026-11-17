import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Command,
  Frame,
  Grid2X2,
  Heart,
  Images,
  LocateFixed,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings2,
  ShieldBan,
  SkipBack,
  SkipForward,
  Sparkles,
  Timer,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { casefold } from "../../shared/tags";
import type { GalleryMode } from "../../shared/types";
import type { GalleryDensity, GalleryFraming } from "../lib/gallery-prefs";
import { motionTransition } from "../lib/motion";

export interface CommandPaletteProps {
  open: boolean;
  t: (key: string) => string;
  mode: GalleryMode;
  density: GalleryDensity;
  framing: GalleryFraming;
  rotationOff: boolean;
  rotationPaused: boolean;
  onClose: () => void;
  onSelectMode: (mode: GalleryMode) => void;
  onOpenSettings: () => void;
  onNextWallpaper: () => void;
  onPrevWallpaper: () => void;
  onLocateCurrent: () => void;
  onToggleRotation: () => void;
  onCycleDensity: () => void;
  onToggleFraming: () => void;
  onRetrainModel: () => void;
}

interface ActionItem {
  id: string;
  label: string;
  detail?: string;
  keys?: string[];
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  run: () => void;
}

interface ShortcutGroup {
  title: string;
  rows: Array<{ keys: string[]; label: string }>;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  t,
  density,
  framing,
  rotationOff,
  rotationPaused,
  onClose,
  onSelectMode,
  onOpenSettings,
  onNextWallpaper,
  onPrevWallpaper,
  onLocateCurrent,
  onToggleRotation,
  onCycleDensity,
  onToggleFraming,
  onRetrainModel,
}) => {
  const reducedMotion = useReducedMotion();
  const isMac = window.wayper.platform === "darwin";
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const densityLabel =
    density === "compact"
      ? t("Compact")
      : density === "gallery"
        ? t("Gallery")
        : t("Standard");
  const framingLabel = framing === "matte" ? t("Matte") : t("Fill");

  const actions: ActionItem[] = useMemo(
    () => [
      {
        id: "next",
        label: t("Next wallpaper"),
        keys: ["L"],
        icon: SkipForward,
        run: onNextWallpaper,
      },
      {
        id: "prev",
        label: t("Previous wallpaper"),
        keys: ["H"],
        icon: SkipBack,
        run: onPrevWallpaper,
      },
      {
        id: "locate",
        label: t("Locate current wallpaper"),
        keys: ["G"],
        icon: LocateFixed,
        run: onLocateCurrent,
      },
      {
        id: "pool",
        label: t("Pool"),
        keys: ["1"],
        icon: Images,
        run: () => onSelectMode("pool"),
      },
      {
        id: "favorites",
        label: t("Favorites"),
        keys: ["2"],
        icon: Heart,
        run: () => onSelectMode("favorites"),
      },
      {
        id: "review",
        label: t("Review"),
        keys: ["3"],
        icon: Sparkles,
        run: () => onSelectMode("model-review"),
      },
      {
        id: "blocklist",
        label: t("Blocklist"),
        keys: ["4"],
        icon: ShieldBan,
        run: () => onSelectMode("trash"),
      },
      {
        id: "density",
        label: t("Cycle grid size"),
        detail: densityLabel,
        icon: Grid2X2,
        run: onCycleDensity,
      },
      {
        id: "framing",
        label: t("Toggle matte framing"),
        detail: framingLabel,
        icon: Frame,
        run: onToggleFraming,
      },
      {
        id: "rotation",
        label: rotationOff
          ? t("Configure Auto Rotation")
          : rotationPaused
            ? t("Resume Auto Rotation")
            : t("Pause Auto Rotation"),
        icon: rotationOff ? Timer : rotationPaused ? Play : Pause,
        run: onToggleRotation,
      },
      {
        id: "retrain",
        label: t("Retrain model"),
        icon: RefreshCw,
        run: onRetrainModel,
      },
      {
        id: "settings",
        label: t("Settings"),
        keys: ["S"],
        icon: Settings2,
        run: onOpenSettings,
      },
    ],
    [
      t,
      densityLabel,
      framingLabel,
      rotationOff,
      rotationPaused,
      onNextWallpaper,
      onPrevWallpaper,
      onLocateCurrent,
      onSelectMode,
      onCycleDensity,
      onToggleFraming,
      onToggleRotation,
      onRetrainModel,
      onOpenSettings,
    ],
  );

  const shortcutGroups: ShortcutGroup[] = useMemo(
    () => [
      {
        title: t("Gallery & Stage"),
        rows: [
          { keys: ["/"], label: t("Search tags, @uploader, or filename...") },
          { keys: ["F"], label: t("Favorite") },
          { keys: ["D"], label: t("Dislike") },
          { keys: ["X"], label: t("Ban") },
          { keys: ["U"], label: t("Undo last ban or dislike") },
          { keys: ["G", "G"], label: t("Jump to top") },
          { keys: ["⇧", "G"], label: t("Jump to bottom") },
          { keys: ["⇧", "1–9"], label: t("Switch monitor") },
          { keys: ["F1–F3"], label: t("Purity") },
          { keys: ["F4"], label: t("View options") },
        ],
      },
      {
        title: t("Model Review"),
        rows: [
          { keys: ["A"], label: t("Keep") },
          { keys: ["D"], label: t("Dislike") },
          { keys: ["←", "→"], label: t("Next candidate") },
          { keys: ["Space"], label: t("View full size") },
          { keys: ["[", "]"], label: t("Previous / Next tab") },
        ],
      },
      {
        title: t("Lightbox"),
        rows: [
          { keys: ["↵"], label: t("Set Wallpaper") },
          { keys: ["I"], label: t("Details") },
          { keys: ["O"], label: t("Open on Wallhaven") },
          { keys: ["+", "-"], label: t("Zoom in") },
          { keys: ["0"], label: t("Reset zoom") },
          { keys: ["Esc"], label: t("Close") },
        ],
      },
    ],
    [t],
  );

  const folded = casefold(query.trim());

  const filteredActions = useMemo(() => {
    if (!folded) return actions;
    return actions.filter(
      (item) =>
        casefold(item.label).includes(folded) ||
        (item.detail && casefold(item.detail).includes(folded)) ||
        (item.keys && item.keys.some((k) => casefold(k).includes(folded))),
    );
  }, [actions, folded]);

  const filteredGroups = useMemo(() => {
    if (!folded) return shortcutGroups;
    return shortcutGroups
      .map((group) => ({
        ...group,
        rows: group.rows.filter(
          (row) =>
            casefold(row.label).includes(folded) ||
            row.keys.some((k) => casefold(k).includes(folded)),
        ),
      }))
      .filter((group) => group.rows.length > 0);
  }, [shortcutGroups, folded]);

  useEffect(() => {
    setActiveIndex(0);
  }, [folded]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown" && filteredActions.length > 0) {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % filteredActions.length);
        return;
      }
      if (e.key === "ArrowUp" && filteredActions.length > 0) {
        e.preventDefault();
        setActiveIndex((prev) => (prev <= 0 ? filteredActions.length - 1 : prev - 1));
        return;
      }
      if (e.key === "Enter" && filteredActions[activeIndex]) {
        e.preventDefault();
        const chosen = filteredActions[activeIndex];
        onClose();
        chosen.run();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, filteredActions, activeIndex, onClose]);

  const isEmpty = filteredActions.length === 0 && filteredGroups.length === 0;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="command-palette-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={motionTransition.fast}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
          className="sheet-scrim fixed inset-0 z-50 flex items-center justify-center p-6"
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={t("Commands & shortcuts")}
            initial={{
              opacity: 0,
              transform: reducedMotion ? "none" : "translate3d(0, 12px, 0) scale(0.98)",
            }}
            animate={{ opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" }}
            exit={{
              opacity: 0,
              transform: reducedMotion ? "none" : "translate3d(0, 8px, 0) scale(0.99)",
            }}
            transition={motionTransition.normal}
            className="sheet-surface flex h-[min(680px,100%)] w-[min(880px,100%)] flex-col overflow-hidden rounded-[22px]"
          >
            <div className="flex h-14 shrink-0 items-center gap-3 px-6 shadow-[inset_0_-1px_0_var(--color-line)]">
              <Search className="h-4 w-4 shrink-0 text-ink-3" strokeWidth={1.75} />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("Type a command or search shortcuts...")}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder-ink-3 outline-none"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label={t("Clear search")}
                  className="flex h-6 w-6 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-white/10 hover:text-ink"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : (
                <span className="inline-flex items-center gap-1 text-ink-3" aria-hidden="true">
                  {isMac ? (
                    <Command className="h-3 w-3" />
                  ) : (
                    <kbd className="keycap">Ctrl</kbd>
                  )}
                  <kbd className="keycap">K</kbd>
                </span>
              )}
              <button
                type="button"
                onClick={onClose}
                title={`${t("Close")} [Esc]`}
                aria-label={t("Close")}
                className="ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-white/[0.07] hover:text-ink"
              >
                <X className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </div>

            <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
              {isEmpty ? (
                <div className="flex h-full items-center justify-center text-center text-[13.5px] text-ink-3">
                  {t("No matching commands or shortcuts")}
                </div>
              ) : (
                <>
                  {filteredActions.length > 0 && (
                    <section>
                      <div className="mb-2 px-2.5 text-[12px] font-medium text-ink-3">
                        {t("Quick Actions")}
                      </div>
                      <div
                        role="listbox"
                        className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3"
                      >
                        {filteredActions.map((action, idx) => {
                          const Icon = action.icon;
                          const selected = idx === activeIndex;
                          return (
                            <button
                              key={action.id}
                              type="button"
                              role="option"
                              aria-selected={selected}
                              onMouseEnter={() => setActiveIndex(idx)}
                              onClick={() => {
                                onClose();
                                action.run();
                              }}
                              className={`flex h-9 items-center justify-between gap-2.5 rounded-xl px-3 text-left text-[13px] transition-colors ${
                                selected
                                  ? "bg-white/[0.11] text-ink"
                                  : "bg-white/[0.025] text-ink-2 hover:bg-white/[0.06] hover:text-ink"
                              }`}
                            >
                              <span className="flex min-w-0 items-center gap-2.5">
                                <Icon className="h-3.5 w-3.5 shrink-0 text-ink-3" strokeWidth={1.75} />
                                <span className="truncate">{action.label}</span>
                              </span>
                              <span className="flex shrink-0 items-center gap-1.5">
                                {action.detail && (
                                  <span className="text-[11.5px] text-ink-3">{action.detail}</span>
                                )}
                                {action.keys?.map((k, i) => (
                                  <kbd key={`${action.id}-${k}-${i}`} className="keycap keycap-bright">
                                    {k}
                                  </kbd>
                                ))}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  {filteredGroups.length > 0 && (
                    <div className="grid grid-cols-1 gap-x-8 gap-y-5 border-t border-line pt-5 sm:grid-cols-3">
                      {filteredGroups.map((group) => (
                        <section key={group.title} className="space-y-1.5">
                          <h3 className="m-0 px-2 text-[12px] font-medium text-ink-3">
                            {group.title}
                          </h3>
                          <ul className="m-0 list-none space-y-0.5 p-0">
                            {group.rows.map((row) => (
                              <li
                                key={`${group.title}-${row.label}`}
                                className="flex items-center justify-between gap-3 rounded-lg px-2 py-1 text-[12.5px]"
                              >
                                <span className="min-w-0 truncate text-ink-2">{row.label}</span>
                                <span className="flex shrink-0 items-center gap-1">
                                  {row.keys.map((k, idx) => (
                                    <kbd key={`${row.label}-${k}-${idx}`} className="keycap">
                                      {k}
                                    </kbd>
                                  ))}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
