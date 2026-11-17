import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, useIsPresent, useReducedMotion } from "motion/react";
import type { ImageItem, ReviewCandidateItem } from "../../shared/types";
import { useDecodedImage, type DecodedImage } from "../lib/decoded-image";
import {
  defaultLightboxBounds,
  fitImage,
  imageOriginTransform,
  previewDimension,
  type ImageBounds,
} from "../lib/lightbox-layout";
import {
  estimateItemAspect,
  findSourceTileImage,
  getReadyLightboxPreview,
  lightboxPreviewUrls,
} from "../lib/lightbox-preview";
import {
  fullImgUrl,
  thumbUrl,
  trashThumbUrl,
  trashUrl,
} from "../lib/media";
import { motionEase, motionTransition } from "../lib/motion";
import type { LightboxContextKind } from "./Lightbox";

export interface LightboxExit {
  closing: boolean;
  direction: number;
}

interface LightboxImageProps {
  item: ImageItem | ReviewCandidateItem;
  context: LightboxContextKind;
  opening: boolean;
  direction: number;
  scale: number;
  pan: { x: number; y: number };
  dragging: boolean;
  imageRef: React.RefObject<HTMLImageElement | null>;
  onNaturalSize: (size: { w: number; h: number }) => void;
  onEntered: () => void;
}

function sourceTransform(itemPath: string, target: ImageBounds): string | null {
  const source = findSourceTileImage(itemPath)?.closest<HTMLElement>("[data-path]");
  if (!source) return null;
  const rect = source.getBoundingClientRect();
  if (
    rect.width <= 0 || rect.height <= 0 ||
    rect.top < 56 || rect.bottom > window.innerHeight - 72 ||
    rect.right <= 0 || rect.left >= window.innerWidth
  ) return null;
  return imageOriginTransform(rect, target);
}

const REST_TRANSFORM = "translate3d(0px, 0px, 0) scale(1)";

export const LightboxImage: React.FC<LightboxImageProps> = ({
  item,
  context,
  opening,
  direction,
  scale,
  pan,
  dragging,
  imageRef,
  onNaturalSize,
  onEntered,
}) => {
  const reducedMotion = useReducedMotion();
  const isPresent = useIsPresent();
  const areaRef = useRef<HTMLDivElement>(null);
  const [settled, setSettled] = useState(false);
  const [originalRequested, setOriginalRequested] = useState(false);
  const [shownOriginal, setShownOriginal] = useState<DecodedImage | null>(null);
  const [bounds, setBounds] = useState<ImageBounds>(() =>
    defaultLightboxBounds(window.innerWidth, window.innerHeight),
  );
  const [aspect, setAspect] = useState(() => {
    const ready = getReadyLightboxPreview(item, context, bounds);
    if (ready && ready.width > 0 && ready.height > 0) {
      return ready.width / ready.height;
    }
    return estimateItemAspect(item);
  });
  const size = fitImage(aspect, bounds);
  const target = {
    ...size,
    left: bounds.left + (bounds.width - size.width) / 2,
    top: bounds.top + (bounds.height - size.height) / 2,
  };
  const [entrance] = useState(() => {
    if (reducedMotion) {
      return { transform: REST_TRANSFORM, fromTile: true };
    }
    if (!opening) {
      return { transform: `translate3d(${direction * 28}px, 0px, 0) scale(1)`, fromTile: false };
    }
    const tileOrigin = sourceTransform(item.path, target);
    return tileOrigin
      ? { transform: tileOrigin, fromTile: true }
      : { transform: "translate3d(0px, 8px, 0) scale(0.97)", fromTile: false };
  });
  const attachImage = useCallback((node: HTMLImageElement | null) => {
    if (!node) return;
    imageRef.current = node;
    return () => {
      if (imageRef.current === node) imageRef.current = null;
    };
  }, [imageRef]);

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const measure = () => {
      const rect = area.getBoundingClientRect();
      setBounds({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  const dimension = previewDimension(size, window.devicePixelRatio || 1);
  const thumbnail = context === "trash" ? trashThumbUrl(item.name) : thumbUrl(item.path);
  const { targetUrl, fallbackUrl } = lightboxPreviewUrls(item, context, dimension);
  const targetPreview = useDecodedImage(isPresent ? targetUrl : null);
  const fallbackPreview = useDecodedImage(isPresent && !targetPreview ? fallbackUrl : null);
  const currentPreview = targetPreview ?? fallbackPreview;
  const [retainedPreview, setRetainedPreview] = useState<DecodedImage | null>(() => currentPreview);
  const activePreview = currentPreview ?? retainedPreview;
  const [previewReadyAtMount] = useState(() => activePreview !== null);
  const original = useDecodedImage(
    originalRequested && isPresent
      ? context === "trash" ? trashUrl(item.name) : fullImgUrl(item.path)
      : null,
  );

  useEffect(() => {
    if (currentPreview) {
      setRetainedPreview(currentPreview);
      const nextAspect = currentPreview.width / currentPreview.height;
      setAspect((previous) => (Math.abs(previous - nextAspect) > 0.005 ? nextAspect : previous));
    }
  }, [currentPreview]);

  useEffect(() => {
    if (reducedMotion && isPresent && !settled) {
      setSettled(true);
      onEntered();
    }
  }, [reducedMotion, isPresent, settled, onEntered]);

  useEffect(() => {
    if (!settled || !isPresent || scale <= 1 || originalRequested) return;
    const timer = window.setTimeout(() => setOriginalRequested(true), 160);
    return () => window.clearTimeout(timer);
  }, [settled, isPresent, scale, originalRequested]);

  useEffect(() => {
    if (original) {
      setShownOriginal(original);
      onNaturalSize({ w: original.width, h: original.height });
    }
  }, [original, onNaturalSize]);

  return (
    <div
      ref={areaRef}
      data-lightbox-area="true"
      style={{ left: 64, right: 64, top: 56, bottom: 88 }}
      className="pointer-events-none absolute grid place-items-center"
    >
      <motion.div
        initial={{ opacity: entrance.fromTile ? 1 : 0, transform: entrance.transform }}
        animate={{ opacity: 1, transform: REST_TRANSFORM }}
        variants={{
          exit: (exit: LightboxExit) => ({
            opacity: 0,
            transform: reducedMotion ? REST_TRANSFORM : exit.closing && scale === 1
              ? sourceTransform(item.path, target) ?? "translate3d(0px, 6px, 0) scale(0.97)"
              : exit.closing ? "translate3d(0px, 0px, 0) scale(0.98)"
                : `translate3d(${-exit.direction * 20}px, 0px, 0) scale(1)`,
            transition: exit.closing ? motionTransition.normal : motionTransition.fast,
          }),
        }}
        exit="exit"
        transition={opening ? motionTransition.reveal : motionTransition.normal}
        onAnimationComplete={() => {
          if (isPresent) {
            setSettled(true);
            onEntered();
          }
        }}
        style={{ ...size, willChange: "transform, opacity" }}
      >
        <div
          className="lightbox-image relative h-full w-full"
          style={{
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`,
            transition: dragging || reducedMotion ? "none" : undefined,
          }}
        >
          <img
            ref={attachImage}
            src={thumbnail}
            alt={item.name}
            draggable={false}
            decoding="async"
            data-lightbox-image="thumbnail"
            onLoad={(event) => {
              const image = event.currentTarget;
              if (!activePreview && image.naturalHeight > 0) {
                const nextAspect = image.naturalWidth / image.naturalHeight;
                setAspect((previous) => (Math.abs(previous - nextAspect) > 0.005 ? nextAspect : previous));
              }
            }}
            className="pointer-events-auto absolute inset-0 h-full w-full rounded-lg object-contain select-none"
          />
          {activePreview && (
            <motion.img
              src={activePreview.source}
              alt=""
              aria-hidden="true"
              draggable={false}
              decoding="async"
              data-lightbox-image="preview"
              initial={previewReadyAtMount || !settled || Boolean(reducedMotion) ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.08, ease: motionEase }}
              className="pointer-events-none absolute inset-0 h-full w-full rounded-lg object-contain select-none"
            />
          )}
          {shownOriginal && (
            <img
              src={shownOriginal.source}
              alt=""
              aria-hidden="true"
              draggable={false}
              decoding="async"
              data-lightbox-image="original"
              className="pointer-events-none absolute inset-0 h-full w-full rounded-lg object-contain select-none"
            />
          )}
        </div>
      </motion.div>
    </div>
  );
};
