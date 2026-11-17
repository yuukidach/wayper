import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type PanInfo,
} from "motion/react";
import type {
  LearningStatus,
  ModelReviewListResponse,
  MonitorInfo,
  Orientation,
  PreferenceSuggestionsResponse,
  Purity,
  ReviewCandidateItem,
} from "../../shared/types";
import { NON_PREFERENCE_FEATURE_TAGS } from "../../shared/tags";
import { renderAmbient } from "../lib/ambient";
import { prewarmLightboxPreview } from "../lib/lightbox-preview";
import { previewUrl, thumbUrl } from "../lib/media";
import { motionTransition, prefersReducedMotion } from "../lib/motion";
import { MonitorTiles } from "./MonitorTiles";

export type ReviewLane = "held" | "recommended";

export interface ReviewWorkspaceHandle {
  moveSelection: (delta: -1 | 1) => void;
  decideCurrent: (action: "keep" | "ban") => Promise<void>;
  openCurrentInLightbox: () => void;
  getCurrentItem: () => ReviewCandidateItem | null;
  getCurrentLane: () => ReviewLane;
  refresh: () => Promise<void>;
}

interface ReviewWorkspaceProps {
  t: (key: string) => string;
  clearingAutoHeld: boolean;
  onClearAutoHeld: () => void;
  purities: Purity[];
  orientation: Orientation;
  monitors: MonitorInfo[];
  activeMonitorName: string | null;
  onSelectMonitor: (monitorName: string) => void;
  lane: ReviewLane;
  onLaneChange: (lane: ReviewLane) => void;
  refreshToken: number;
  onCountsChange: (held: number, recommended: number) => void;
  onOpenReviewLightbox: (
    item: ReviewCandidateItem,
    items: ReviewCandidateItem[],
    lane: ReviewLane,
  ) => void;
  onBrowsePool: () => void;
  onOpenWallhaven: (filenameOrPath: string) => void;
  onNotify: (text: string, tone?: "info" | "success" | "error") => void;
}

function evidenceLabel(feature: string): React.ReactNode {
  const match = /^([a-z_]+):\s*(.+)$/i.exec(feature);
  if (!match) return feature;
  const [, kind, value] = match;
  if (kind === "color" && /^#[0-9a-f]{3,8}$/i.test(value)) {
    return (
      <>
        <span
          className="h-2.5 w-2.5 rounded-full shadow-[inset_0_0_0_1px_rgb(255_255_255/0.2)]"
          style={{ backgroundColor: value }}
        />
        <span className="tabular-nums">{value.toLowerCase()}</span>
      </>
    );
  }
  if (kind === "uploader") return `@${value}`;
  return (
    <>
      <span className="text-ink-3">{kind}</span>
      <span>{value}</span>
    </>
  );
}

type ExitIntent = "keep" | "ban" | "next" | "prev" | "fade";

const DECISION_COMMIT_DELAY_MS = 340;

// Every deck transition touches only transform and opacity, so the compositor
// can run it without repainting or re-laying out the wallpaper.
const deckVariants = {
  enter: (intent: ExitIntent) =>
    intent === "prev"
      ? { opacity: 0, x: -72, y: 0, scale: 1, zIndex: 2 }
      : { opacity: 0, x: 0, y: 26, scale: 0.9, zIndex: 1 },
  top: { opacity: 1, x: 0, y: 0, scale: 1, zIndex: 2, transition: motionTransition.reveal },
  behind: { opacity: 1, x: 0, y: 18, scale: 0.94, zIndex: 1, transition: motionTransition.reveal },
  // A card that was decided or skipped leaves above the one taking its place.
  exit: (intent: ExitIntent) => {
    if (intent === "keep" || intent === "ban") {
      const fly = Math.max(720, window.innerWidth * 0.8);
      return {
        x: intent === "keep" ? -fly : fly,
        opacity: 0,
        zIndex: 3,
        transition: {
          x: { duration: 0.3, ease: [0.5, 0, 0.9, 0.5] as const },
          opacity: { duration: 0.22, delay: 0.08, ease: "linear" as const },
        },
      };
    }
    if (intent === "next") {
      return {
        x: -72,
        opacity: 0,
        zIndex: 3,
        transition: { duration: 0.16, ease: "easeOut" as const },
      };
    }
    return { opacity: 0, zIndex: 0, transition: { duration: 0.14 } };
  },
};

const shadeVariants = {
  enter: { opacity: 0.58 },
  top: { opacity: 0, transition: { duration: 0.22, ease: "easeOut" as const } },
  behind: { opacity: 0.58, transition: { duration: 0.22, ease: "easeOut" as const } },
  exit: { opacity: 0 },
};

/** Keeps the on-screen order stable and appends candidates that are new. */
function mergeQueue(
  previous: ReviewCandidateItem[],
  next: ReviewCandidateItem[],
): ReviewCandidateItem[] {
  if (previous.length === 0) return next;
  const fresh = new Map(next.map((item) => [item.path, item]));
  const merged: ReviewCandidateItem[] = [];
  for (const item of previous) {
    const updated = fresh.get(item.path);
    if (updated) {
      merged.push(updated);
      fresh.delete(item.path);
    }
  }
  merged.push(...fresh.values());
  return merged;
}

interface MediaProbe {
  aspect: number;
  ambient: string | null;
}

function guessAspect(item: ReviewCandidateItem): number {
  return item.orientation === "portrait" ? 9 / 16 : 16 / 9;
}

interface DeckCardProps {
  item: ReviewCandidateItem;
  isTop: boolean;
  intent: ExitIntent;
  aspect: number;
  stageWidth: number;
  stageHeight: number;
  keepLabel: string;
  dropLabel: string;
  onDecide: (action: "keep" | "ban") => void;
  onOpen: () => void;
}

const DeckCard: React.FC<DeckCardProps> = ({
  item,
  isTop,
  intent,
  aspect,
  stageWidth,
  stageHeight,
  keepLabel,
  dropLabel,
  onDecide,
  onOpen,
}) => {
  const reducedMotion = useReducedMotion();
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-420, 420], reducedMotion ? [0, 0] : [-7, 7]);
  // Keep sits on the left and dislike on the right, like the A and D keys.
  const keepOpacity = useTransform(x, [-130, -28], [1, 0]);
  const dropOpacity = useTransform(x, [28, 130], [0, 1]);
  const keepScale = useTransform(x, [-130, -28], [1, 0.82]);
  const dropScale = useTransform(x, [28, 130], [0.82, 1]);
  const draggedRef = useRef(false);

  const width = Math.max(0, Math.round(Math.min(stageWidth, stageHeight * aspect)));
  const height = aspect > 0 ? Math.round(width / aspect) : 0;

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    const decided =
      info.offset.x < -120 || info.velocity.x < -650
        ? "keep"
        : info.offset.x > 120 || info.velocity.x > 650
          ? "ban"
          : null;
    if (decided) {
      onDecide(decided);
    } else {
      animate(x, 0, reducedMotion ? { duration: 0 } : motionTransition.select);
    }
  };

  return (
    <motion.div
      data-path={item.path}
      custom={intent}
      variants={deckVariants}
      initial="enter"
      animate={isTop ? "top" : "behind"}
      exit="exit"
      drag={isTop ? "x" : false}
      dragMomentum={false}
      onTapStart={() => {
        draggedRef.current = false;
      }}
      onDragStart={() => {
        draggedRef.current = true;
      }}
      onDragEnd={handleDragEnd}
      onTap={() => {
        if (isTop && !draggedRef.current) onOpen();
      }}
      whileDrag={{ cursor: "grabbing" }}
      style={{
        x,
        rotate,
        width,
        height,
        gridArea: "1 / 1",
        backgroundImage: `url("${thumbUrl(item.path)}")`,
      }}
      className={`relative overflow-hidden rounded-[18px] bg-well bg-cover bg-center shadow-[0_22px_48px_-24px_rgb(0_0_0/0.85),0_0_0_1px_rgb(255_255_255/0.09)] will-change-transform ${
        isTop ? "cursor-grab" : "pointer-events-none"
      }`}
    >
      <img
        src={previewUrl(item.path)}
        alt={item.name}
        decoding="async"
        draggable={false}
        className="pointer-events-none h-full w-full object-cover select-none"
      />
      <motion.div
        variants={shadeVariants}
        className="pointer-events-none absolute inset-0 bg-black"
      />
      {isTop && (
        <>
          <motion.span
            style={{ opacity: keepOpacity, scale: keepScale }}
            className="pointer-events-none absolute top-5 right-5 inline-flex h-11 origin-top-right items-center gap-2 rounded-full bg-keep pr-5 pl-4 text-[15px] font-semibold text-black shadow-[0_10px_28px_rgb(0_0_0/0.4)] will-change-[opacity,transform]"
          >
            <Check className="h-5 w-5" strokeWidth={2.5} />
            {keepLabel}
          </motion.span>
          <motion.span
            style={{ opacity: dropOpacity, scale: dropScale }}
            className="pointer-events-none absolute top-5 left-5 inline-flex h-11 origin-top-left items-center gap-2 rounded-full bg-drop pr-5 pl-4 text-[15px] font-semibold text-black shadow-[0_10px_28px_rgb(0_0_0/0.4)] will-change-[opacity,transform]"
          >
            <X className="h-5 w-5" strokeWidth={2.5} />
            {dropLabel}
          </motion.span>
        </>
      )}
    </motion.div>
  );
};

const ScoreRing: React.FC<{ value: number; threshold?: number }> = ({ value, threshold }) => {
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(1, Math.max(0, value));
  const over = typeof threshold === "number" && value >= threshold;
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" className="-rotate-90" aria-hidden="true">
      <circle cx="12" cy="12" r={radius} fill="none" stroke="rgb(255 255 255 / 0.14)" strokeWidth="2.5" />
      <motion.circle
        cx="12"
        cy="12"
        r={radius}
        fill="none"
        stroke={over ? "var(--color-drop)" : "var(--color-ink)"}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        initial={false}
        animate={{ strokeDashoffset: circumference * (1 - clamped) }}
        transition={{ type: "spring", stiffness: 160, damping: 26 }}
      />
    </svg>
  );
};

export const ReviewWorkspace = forwardRef<ReviewWorkspaceHandle, ReviewWorkspaceProps>(
  (
    {
      t,
      clearingAutoHeld,
      onClearAutoHeld,
      purities,
      orientation,
      monitors,
      activeMonitorName,
      onSelectMonitor,
      lane,
      onLaneChange,
      refreshToken,
      onCountsChange,
      onOpenReviewLightbox,
      onBrowsePool,
      onOpenWallhaven,
      onNotify,
    },
    ref,
  ) => {
    const [heldData, setHeldData] = useState<ModelReviewListResponse | null>(null);
    const [recData, setRecData] = useState<PreferenceSuggestionsResponse | null>(null);
    const [heldItems, setHeldItems] = useState<ReviewCandidateItem[]>([]);
    const [recItems, setRecItems] = useState<ReviewCandidateItem[]>([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [exitIntent, setExitIntent] = useState<ExitIntent>("fade");
    const [loading, setLoading] = useState(true);
    const [errorState, setErrorState] = useState<string | null>(null);
    const [retraining, setRetraining] = useState(false);

    const inFlightPathsRef = useRef<Set<string>>(new Set());
    const autoLaneInitializedRef = useRef(false);
    const seqRef = useRef(0);
    const loadedRef = useRef(false);

    const purityKey = useMemo(() => [...purities].sort().join(","), [purities]);
    const scopeRef = useRef({ purities, orientation });
    scopeRef.current = { purities, orientation };

    /**
     * The first load of a scope shows a spinner.  Every later refresh is silent:
     * the deck stays on screen and the fresh queue is merged into it.
     */
    const fetchBothLanes = useCallback(async () => {
      const seq = ++seqRef.current;
      const silent = loadedRef.current;
      if (!silent) {
        setLoading(true);
        setErrorState(null);
      }
      try {
        const scope = scopeRef.current;
        const [heldRes, recRes] = await Promise.all([
          window.wayper.getModelReview({
            purities: scope.purities,
            orient: scope.orientation,
            limit: 80,
          }),
          window.wayper.getPreferenceSuggestions({
            purities: scope.purities,
            orient: scope.orientation,
            limit: 60,
          }),
        ]);
        if (seq !== seqRef.current) return;

        const busy = inFlightPathsRef.current;
        const nextHeld = (heldRes.items ?? [])
          .filter((item) => !busy.has(item.path))
          .map((item) => ({ ...item, auto_filtered: true }));
        const nextRec = (recRes.items ?? [])
          .filter((item) => !busy.has(item.path))
          .map((item) => ({ ...item, auto_filtered: false }));

        loadedRef.current = true;
        setErrorState(null);
        setHeldData(heldRes);
        setRecData(recRes);
        setHeldItems((prev) => mergeQueue(prev, nextHeld));
        setRecItems((prev) => mergeQueue(prev, nextRec));

        if (!autoLaneInitializedRef.current) {
          autoLaneInitializedRef.current = true;
          if (nextHeld.length === 0 && nextRec.length > 0) {
            onLaneChange("recommended");
          } else if (nextHeld.length > 0) {
            onLaneChange("held");
          }
        }
      } catch (err) {
        if (seq !== seqRef.current) return;
        console.error("Failed loading review workspace:", err);
        if (!silent) {
          setErrorState(err instanceof Error ? err.message : "Failed to load review queue");
        }
      } finally {
        if (seq === seqRef.current) {
          setLoading(false);
        }
      }
    }, [onLaneChange]);

    useEffect(() => {
      loadedRef.current = false;
      autoLaneInitializedRef.current = false;
      setHeldItems([]);
      setRecItems([]);
      void fetchBothLanes();
    }, [purityKey, orientation, fetchBothLanes]);

    const seenRefreshTokenRef = useRef(refreshToken);
    useEffect(() => {
      if (seenRefreshTokenRef.current === refreshToken) return;
      seenRefreshTokenRef.current = refreshToken;
      const timer = window.setTimeout(() => void fetchBothLanes(), 250);
      return () => window.clearTimeout(timer);
    }, [refreshToken, fetchBothLanes]);

    useEffect(() => {
      onCountsChange(heldItems.length, recItems.length);
    }, [heldItems.length, recItems.length, onCountsChange]);

    const activeItems = lane === "held" ? heldItems : recItems;

    const selectedPathRef = useRef<string | null>(null);
    useEffect(() => {
      setSelectedIndex((prev) => {
        if (activeItems.length === 0) return 0;
        const selectedPath = selectedPathRef.current;
        const kept = selectedPath
          ? activeItems.findIndex((item) => item.path === selectedPath)
          : -1;
        return kept >= 0 ? kept : Math.min(prev, activeItems.length - 1);
      });
    }, [activeItems, lane]);

    const currentItem = activeItems[selectedIndex] ?? null;
    useEffect(() => {
      selectedPathRef.current = currentItem?.path ?? null;
    }, [currentItem]);

    const moveSelection = useCallback(
      (delta: -1 | 1) => {
        if (activeItems.length <= 1) return;
        setExitIntent(delta > 0 ? "next" : "prev");
        setSelectedIndex((prev) => {
          const next = prev + delta;
          if (next < 0) return activeItems.length - 1;
          if (next >= activeItems.length) return 0;
          return next;
        });
      },
      [activeItems.length],
    );

    const decideItem = useCallback(
      async (item: ReviewCandidateItem, action: "keep" | "ban") => {
        if (!item?.path || inFlightPathsRef.current.has(item.path)) return;
        inFlightPathsRef.current.add(item.path);
        const isHeld = Boolean(item.auto_filtered) || lane === "held";

        // Optimistic deck removal for instant keyboard/button flow
        setExitIntent(action);
        if (isHeld) {
          setHeldItems((prev) => prev.filter((x) => x.path !== item.path));
        } else {
          setRecItems((prev) => prev.filter((x) => x.path !== item.path));
        }

        try {
          // Let the card finish leaving before the main process starts moving files.
          await new Promise((resolve) => window.setTimeout(
            resolve, prefersReducedMotion() ? 0 : DECISION_COMMIT_DELAY_MS,
          ));
          if (isHeld) {
            await window.wayper.resolveModelReview(item.path, action);
          } else if (action === "keep") {
            await window.wayper.sendPreferenceFeedback(item.path, "keep");
          } else {
            await window.wayper.banImage(item.path, {
              monitor: activeMonitorName ?? undefined,
              preference_context: "model_review",
            });
          }
        } catch (err) {
          console.error(`Failed review ${action}:`, err);
          // Rollback on failure
          if (isHeld) {
            setHeldItems((prev) => [item, ...prev]);
          } else {
            setRecItems((prev) => [item, ...prev]);
          }
          onNotify(
            err instanceof Error ? err.message : `Could not ${action} ${item.name}`,
            "error",
          );
        } finally {
          inFlightPathsRef.current.delete(item.path);
        }
      },
      [lane, activeMonitorName, onNotify],
    );

    const handleRetrain = async () => {
      if (retraining) return;
      setRetraining(true);
      try {
        await window.wayper.retrainModelNow();
        await fetchBothLanes();
        onNotify(t("Model Ready"), "success");
      } catch (err) {
        onNotify(err instanceof Error ? err.message : "Retrain failed", "error");
      } finally {
        setRetraining(false);
      }
    };

    useImperativeHandle(
      ref,
      () => ({
        moveSelection,
        decideCurrent: async (action) => {
          if (currentItem) {
            await decideItem(currentItem, action);
          }
        },
        openCurrentInLightbox: () => {
          if (currentItem) {
            onOpenReviewLightbox(currentItem, activeItems, lane);
          }
        },
        getCurrentItem: () => currentItem,
        getCurrentLane: () => lane,
        refresh: fetchBothLanes,
      }),
      [moveSelection, currentItem, decideItem, onOpenReviewLightbox, activeItems, lane, fetchBothLanes],
    );

    const learning: LearningStatus | null = recData?.learning ?? heldData?.learning ?? null;
    const recStatus = recData?.status ?? "untrained";
    const isReady = recStatus === "ready" || heldData?.status === "ready";

    const modelBadge = isReady
      ? { label: t("Model Ready"), dot: "bg-keep" }
      : recStatus === "learning" || recStatus === "upgrade_pending" || (learning?.pending_feedback ?? 0) > 0
        ? { label: t("Calibrating"), dot: "bg-warn" }
        : { label: t("Untrained"), dot: "bg-ink-3" };

    const topDislikeEvidence = useMemo(() => {
      if (!currentItem) return [];
      const source =
        currentItem.dislike_evidence?.length > 0
          ? currentItem.dislike_evidence
          : (currentItem.contributions ?? []).filter((c) => c.direction === "dislike");
      return source
        .filter((c) => !NON_PREFERENCE_FEATURE_TAGS.has(c.feature.toLowerCase()))
        .slice(0, 5);
    }, [currentItem]);

    const nearestDislike = currentItem?.neighbor_nearest_dislike ?? null;
    const neighborTagMatches = useMemo(() => {
      return (nearestDislike?.tag_matches ?? []).slice(0, 4);
    }, [nearestDislike]);

    const otherLane: ReviewLane = lane === "held" ? "recommended" : "held";
    const otherLaneCount = otherLane === "held" ? heldItems.length : recItems.length;

    // Aspect ratio and ambient colour come from the thumbnail, and upcoming
    // previews are decoded ahead of time, so a card never resizes or decodes
    // while it is animating.
    const [probes, setProbes] = useState<Record<string, MediaProbe>>({});
    const probeRequestedRef = useRef<Set<string>>(new Set());
    const previewKeepAliveRef = useRef<Map<string, HTMLImageElement>>(new Map());
    useEffect(() => {
      const upcoming = activeItems.slice(selectedIndex, selectedIndex + 4);
      const previous = selectedIndex > 0 ? activeItems[selectedIndex - 1] : undefined;
      if (previous) upcoming.push(previous);
      const keepAlive = previewKeepAliveRef.current;
      for (const item of upcoming) {
        if (!probeRequestedRef.current.has(item.path)) {
          probeRequestedRef.current.add(item.path);
          const probe = new Image();
          const finish = (aspect: number, ambient: string | null) =>
            setProbes((prev) => ({ ...prev, [item.path]: { aspect, ambient } }));
          probe.crossOrigin = "anonymous";
          probe.decoding = "async";
          probe.onload = () =>
            finish(
              probe.naturalWidth > 0 && probe.naturalHeight > 0
                ? probe.naturalWidth / probe.naturalHeight
                : guessAspect(item),
              renderAmbient(probe),
            );
          probe.onerror = () => finish(guessAspect(item), null);
          probe.src = thumbUrl(item.path);
        }
        const alive = keepAlive.get(item.path);
        if (alive) {
          keepAlive.delete(item.path);
          keepAlive.set(item.path, alive);
        } else {
          const preview = new Image();
          preview.decoding = "async";
          preview.src = previewUrl(item.path);
          void preview.decode().catch(() => undefined);
          keepAlive.set(item.path, preview);
        }
      }
      while (keepAlive.size > 10) {
        const oldest = keepAlive.keys().next().value;
        if (oldest === undefined) break;
        keepAlive.delete(oldest);
      }
    }, [activeItems, selectedIndex]);

    useEffect(() => {
      if (!currentItem) return;
      prewarmLightboxPreview(currentItem, "review");
      const nextItem = activeItems[selectedIndex + 1];
      if (!nextItem) return;
      const timer = window.setTimeout(() => {
        prewarmLightboxPreview(nextItem, "review", false);
      }, 120);
      return () => window.clearTimeout(timer);
    }, [currentItem, activeItems, selectedIndex]);

    const stageRef = useRef<HTMLDivElement | null>(null);
    const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
    const hasDeck = Boolean(currentItem) && !loading && !errorState;
    useEffect(() => {
      const node = stageRef.current;
      if (!node) return;
      const measure = () => setStageSize({ width: node.clientWidth, height: node.clientHeight });
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => observer.disconnect();
    }, [hasDeck]);

    const changeLane = (value: ReviewLane) => {
      if (value === lane) return;
      setExitIntent("fade");
      onLaneChange(value);
    };

    const topProbe = currentItem ? probes[currentItem.path] : undefined;
    const upNext = activeItems[selectedIndex + 1];
    const deck =
      currentItem && topProbe
        ? upNext && probes[upNext.path]
          ? [currentItem, upNext]
          : [currentItem]
        : [];
    const ambient = topProbe?.ambient ?? null;
    const score = currentItem ? (currentItem.decision_score ?? currentItem.score ?? 0) : 0;
    const threshold = currentItem?.threshold ?? recData?.decision_threshold;
    const overThreshold = typeof threshold === "number" && score >= threshold;

    const laneButton = (value: ReviewLane, label: string, count: number) => (
      <button
        type="button"
        role="tab"
        aria-selected={lane === value}
        onClick={() => changeLane(value)}
        className={`relative inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium whitespace-nowrap transition-colors ${
          lane === value ? "text-ink" : "text-ink-2 hover:text-ink"
        }`}
      >
        {lane === value && (
          <motion.span
            layoutId="review-lane-pill"
            className="absolute inset-0 rounded-full bg-white/[0.14]"
            transition={motionTransition.select}
          />
        )}
        <span className="relative">{label}</span>
        <span className={`relative tabular-nums ${lane === value ? "text-ink-2" : "text-ink-3"}`}>
          {count}
        </span>
      </button>
    );

    const ghostButton =
      "inline-flex h-9 items-center justify-center rounded-full px-4 text-[13px] font-medium text-ink transition-colors bg-white/[0.08] hover:bg-white/[0.14]";
    const primaryButton =
      "inline-flex h-9 items-center justify-center rounded-full bg-accent px-4 text-[13px] font-medium text-on-accent transition-colors hover:bg-accent-hi";
    const quietIcon =
      "flex h-7 w-7 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-white/[0.1] hover:text-ink disabled:opacity-50";

    const emptyState = (
      title: string,
      text: React.ReactNode,
      actions: React.ReactNode,
      done = false,
    ) => (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        className="flex max-w-sm flex-col items-center gap-2 px-6 text-center"
      >
        {done && (
          <svg width="56" height="56" viewBox="0 0 56 56" fill="none" className="mb-3" aria-hidden="true">
            <motion.circle
              cx="28"
              cy="28"
              r="25"
              stroke="rgb(255 255 255 / 0.22)"
              strokeWidth="1.5"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.6, ease: "easeOut" }}
            />
            <motion.path
              d="M18.5 28.5l6.5 6.5 12.5-13.5"
              stroke="var(--color-ink)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.35, delay: 0.4, ease: "easeOut" }}
            />
          </svg>
        )}
        <h2 className="m-0 text-[20px] font-semibold tracking-[-0.02em] text-ink">{title}</h2>
        <div className="text-[13.5px] leading-relaxed text-ink-2">{text}</div>
        <div className="mt-4 flex items-center gap-2">{actions}</div>
      </motion.div>
    );

    const decisionItem = !loading && !errorState ? currentItem : null;
    const showDock = Boolean(decisionItem) || monitors.length > 1;

    return (
      <div className="relative flex h-full w-full flex-col overflow-hidden">
        {/* Ambient light: a pre-blurred miniature of the candidate fills the window. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          <AnimatePresence initial={false}>
            {hasDeck && currentItem && ambient && (
              <motion.img
                key={`ambient-${currentItem.path}`}
                src={ambient}
                alt=""
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.72 }}
                exit={{ opacity: 0 }}
                transition={motionTransition.ambient}
                className="absolute inset-0 h-full w-full object-cover"
              />
            )}
          </AnimatePresence>
          <div className="absolute inset-0 bg-gradient-to-b from-frame/50 via-frame/20 to-frame/85" />
        </div>

        <div className="relative flex shrink-0 items-center justify-between gap-3 px-6 pt-[64px]">
          <div className="flex items-center gap-3">
            <div
              role="tablist"
              className="flex items-center gap-0.5 rounded-full bg-white/[0.08] p-0.5"
            >
              {laneButton("held", t("Auto-held"), heldItems.length)}
              {laneButton("recommended", t("Recommended"), recItems.length)}
            </div>
            {hasDeck && (
              <span className="text-[12.5px] tabular-nums text-ink-3">
                {selectedIndex + 1} / {activeItems.length}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1">
            <span
              className="mr-1.5 inline-flex items-center gap-1.5 text-[12.5px] whitespace-nowrap text-ink-2 max-[820px]:hidden"
              title={modelBadge.label}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${modelBadge.dot}`} />
              <span>{modelBadge.label}</span>
              {learning && learning.minimum_feedback > 0 && !isReady && (
                <span className="tabular-nums text-ink-3">
                  {learning.pending_feedback}/{learning.minimum_feedback}
                </span>
              )}
            </span>
            <button
              type="button"
              disabled={retraining}
              onClick={() => void handleRetrain()}
              title={t("Retrain model")}
              aria-label={t("Retrain model")}
              className={quietIcon}
            >
              <RefreshCw
                className={`h-[15px] w-[15px] ${retraining ? "animate-spin" : ""}`}
                strokeWidth={1.75}
              />
            </button>
            {lane === "held" && heldItems.length > 0 && (
              <button
                type="button"
                disabled={clearingAutoHeld}
                onClick={onClearAutoHeld}
                title={`${t("Clear auto-held")} (${heldItems.length})`}
                aria-label={t("Clear auto-held")}
                className={`${quietIcon} hover:bg-drop/15! hover:text-drop!`}
              >
                <Trash2 className="h-[15px] w-[15px]" strokeWidth={1.75} />
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="relative flex flex-1 items-center justify-center">
            <RefreshCw className="h-5 w-5 animate-spin text-ink-3" strokeWidth={1.75} />
          </div>
        ) : errorState ? (
          <div
            className={`relative flex flex-1 items-center justify-center ${showDock ? "" : "pb-16"}`}
          >
            {emptyState(
              t("Review is temporarily unavailable"),
              errorState,
              <>
                <button type="button" onClick={() => void fetchBothLanes()} className={primaryButton}>
                  {t("Try again")}
                </button>
                <button type="button" onClick={onBrowsePool} className={ghostButton}>
                  {t("Back to Pool")}
                </button>
              </>,
            )}
          </div>
        ) : !currentItem ? (
          <div
            className={`relative flex flex-1 items-center justify-center ${showDock ? "" : "pb-16"}`}
          >
            {!isReady && heldItems.length === 0 && recItems.length === 0
              ? emptyState(
                  t("The model is still learning"),
                  <>
                    <p className="m-0">
                      {t(
                        "Dislike wallpapers with [D] and favorite or keep ones you like so the two-stage model can calibrate to 80% precision.",
                      )}
                    </p>
                    {learning && learning.minimum_feedback > 0 && (
                      <div className="mx-auto mt-5 flex w-48 items-center gap-2.5">
                        <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.1]">
                          <motion.div
                            className="h-full rounded-full bg-ink"
                            initial={{ width: 0 }}
                            animate={{
                              width: `${Math.min(
                                100,
                                Math.round(
                                  (learning.pending_feedback / learning.minimum_feedback) * 100,
                                ),
                              )}%`,
                            }}
                            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                          />
                        </div>
                        <span className="text-[12px] tabular-nums text-ink-3">
                          {learning.pending_feedback} / {learning.minimum_feedback}
                        </span>
                      </div>
                    )}
                  </>,
                  <>
                    <button type="button" onClick={onBrowsePool} className={primaryButton}>
                      {t("Browse Pool")}
                    </button>
                    {learning?.training_ready && (
                      <button
                        type="button"
                        onClick={() => void handleRetrain()}
                        className={ghostButton}
                      >
                        {t("Retrain model")}
                      </button>
                    )}
                  </>,
                )
              : emptyState(
                  t("You're all caught up"),
                  t("No auto-held or recommended candidates need your review right now."),
                  <>
                    {otherLaneCount > 0 && (
                      <button
                        type="button"
                        onClick={() => changeLane(otherLane)}
                        className={primaryButton}
                      >
                        {otherLane === "held" ? t("Auto-held") : t("Recommended")} ({otherLaneCount})
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={onBrowsePool}
                      className={otherLaneCount > 0 ? ghostButton : primaryButton}
                    >
                      {t("Browse Pool")}
                    </button>
                  </>,
                  true,
                )}
          </div>
        ) : (
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* The deck */}
            <div className="relative min-h-0 flex-1 px-[72px] pt-3 pb-7">
              <div ref={stageRef} className="grid h-full w-full place-items-center">
                <AnimatePresence custom={exitIntent} initial={false}>
                  {deck.map((item) => (
                    <DeckCard
                      key={item.path}
                      item={item}
                      isTop={item.path === currentItem.path}
                      intent={exitIntent}
                      aspect={probes[item.path]?.aspect ?? guessAspect(item)}
                      stageWidth={stageSize.width}
                      stageHeight={stageSize.height}
                      keepLabel={t("Keep")}
                      dropLabel={t("Dislike")}
                      onDecide={(action) => void decideItem(item, action)}
                      onOpen={() => onOpenReviewLightbox(item, activeItems, lane)}
                    />
                  ))}
                </AnimatePresence>
              </div>

              {activeItems.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={() => moveSelection(-1)}
                    aria-label="Previous candidate"
                    className="group absolute inset-y-0 left-0 flex w-[72px] items-center justify-center outline-none"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-white/60 transition-[transform,background-color,color] duration-150 group-hover:scale-110 group-hover:bg-white/[0.16] group-hover:text-white group-focus-visible:ring-2 group-focus-visible:ring-white/70">
                      <ChevronLeft className="h-5 w-5" strokeWidth={1.75} />
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => moveSelection(1)}
                    aria-label="Next candidate"
                    className="group absolute inset-y-0 right-0 flex w-[72px] items-center justify-center outline-none"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-white/60 transition-[transform,background-color,color] duration-150 group-hover:scale-110 group-hover:bg-white/[0.16] group-hover:text-white group-focus-visible:ring-2 group-focus-visible:ring-white/70">
                      <ChevronRight className="h-5 w-5" strokeWidth={1.75} />
                    </span>
                  </button>
                </>
              )}
            </div>

          </div>
        )}

        {/*
          One dock, where every other view keeps its dock: the displays first,
          then the model's reason on demand and the decision.  Neither answer
          is pre-selected.
        */}
        {showDock && (
          <div className="relative flex shrink-0 items-center justify-center px-6 pt-3 pb-5">
            <motion.div
              initial={{ opacity: 0, y: 28, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={motionTransition.reveal}
              className="dock-surface flex items-center gap-1 rounded-[20px] p-1.5"
            >
              {monitors.length > 1 && (
                <MonitorTiles
                  t={t}
                  monitors={monitors}
                  activeMonitorName={activeMonitorName}
                  onSelectMonitor={onSelectMonitor}
                  className="pr-1 pl-0.5"
                />
              )}
              {decisionItem && (
                <>
                  {monitors.length > 1 && <span className="mx-1 h-5 w-px bg-white/[0.1]" />}
                    <div className="group/why relative">
                      <button
                        type="button"
                        aria-label={`${t("Dislike score")} ${score.toFixed(2)}`}
                        aria-describedby="review-why"
                        className="flex h-10 cursor-default items-center gap-2 rounded-xl pr-3 pl-2.5 text-[13.5px] transition-colors hover:bg-white/[0.08] focus-visible:bg-white/[0.08]"
                      >
                        <ScoreRing value={score} threshold={threshold} />
                        <span className="font-medium tabular-nums text-ink">{score.toFixed(2)}</span>
                      </button>
                      <div
                        id="review-why"
                        role="tooltip"
                        className="dock-surface pointer-events-none absolute bottom-full left-0 z-10 mb-3.5 w-[300px] bg-[rgb(26_26_28/0.97)]! origin-bottom-left translate-y-1.5 scale-[0.98] rounded-2xl p-4 opacity-0 transition-[opacity,transform] duration-150 ease-out group-focus-within/why:translate-y-0 group-focus-within/why:scale-100 group-focus-within/why:opacity-100 group-hover/why:translate-y-0 group-hover/why:scale-100 group-hover/why:opacity-100"
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-[13px] font-medium text-ink">{t("Dislike score")}</span>
                          <span className="text-[13px] tabular-nums text-ink">{score.toFixed(2)}</span>
                        </div>
                        <div className="relative mt-2.5 h-1 rounded-full bg-white/[0.1]">
                          <div
                            className={`h-full rounded-full ${overThreshold ? "bg-drop" : "bg-ink"}`}
                            style={{ width: `${Math.round(Math.min(1, Math.max(0, score)) * 100)}%` }}
                          />
                          {typeof threshold === "number" && (
                            <span
                              className="absolute top-1/2 h-2.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/70"
                              style={{ left: `${Math.round(Math.min(1, Math.max(0, threshold)) * 100)}%` }}
                            />
                          )}
                        </div>
                        {typeof threshold === "number" && (
                          <div className="mt-2 flex items-baseline justify-between gap-3 text-[12px] text-ink-3">
                            <span>{t("Threshold")}</span>
                            <span className="tabular-nums">{threshold.toFixed(2)}</span>
                          </div>
                        )}
                        {nearestDislike && (
                          <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-white/[0.08] pt-3 text-[12.5px]">
                            <span className="text-ink-2">{t("Similar to a disliked wallpaper")}</span>
                            <span className="font-medium tabular-nums text-ink">
                              {Math.round((nearestDislike.similarity ?? 0) * 100)}%
                            </span>
                          </div>
                        )}
                        {(topDislikeEvidence.length > 0 || neighborTagMatches.length > 0) && (
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {topDislikeEvidence.map((ev) => (
                              <span
                                key={`ev-${ev.type}-${ev.feature}`}
                                className="inline-flex h-6 items-center gap-1.5 rounded-full bg-white/[0.08] px-2.5 text-[12px] text-ink-2"
                              >
                                {evidenceLabel(ev.feature)}
                              </span>
                            ))}
                            {neighborTagMatches.map((tm, i) => (
                              <span
                                key={`tm-${tm.query}-${tm.prototype}-${i}`}
                                className="inline-flex h-6 items-center rounded-full px-2.5 text-[12px] text-ink-3 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12)]"
                              >
                                {tm.query === tm.prototype ? tm.query : `${tm.query} ≈ ${tm.prototype}`}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <span className="mx-1 h-5 w-px bg-white/[0.1]" />
                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.95 }}
                      onClick={() => void decideItem(decisionItem, "keep")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl pr-3 pl-3.5 text-[13.5px] font-medium text-ink transition-colors hover:bg-keep/15 hover:text-keep"
                    >
                      <Check className="h-4 w-4" strokeWidth={2} />
                      <span>{t("Keep")}</span>
                      <kbd className="keycap">A</kbd>
                    </motion.button>
                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.95 }}
                      onClick={() => void decideItem(decisionItem, "ban")}
                      className="inline-flex h-10 items-center gap-2 rounded-xl pr-3 pl-3.5 text-[13.5px] font-medium text-ink transition-colors hover:bg-drop/15 hover:text-drop"
                    >
                      <X className="h-4 w-4" strokeWidth={2} />
                      <span>{t("Dislike")}</span>
                      <kbd className="keycap">D</kbd>
                    </motion.button>
                    <span className="mx-1 h-5 w-px bg-white/[0.1]" />
                    <button
                      type="button"
                      onClick={() => onOpenWallhaven(decisionItem.name)}
                      title={`${t("Open on Wallhaven")} [O]`}
                      aria-label={t("Open on Wallhaven")}
                      className="flex h-10 w-10 items-center justify-center rounded-xl text-ink-2 transition-colors hover:bg-white/[0.08] hover:text-ink"
                    >
                      <ExternalLink className="h-4 w-4" strokeWidth={1.75} />
                    </button>
                </>
              )}
            </motion.div>
          </div>
        )}
      </div>
    );
  },
);

ReviewWorkspace.displayName = "ReviewWorkspace";
