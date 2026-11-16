import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import type { ImageItem, ReviewCandidateItem } from "../../shared/types";
import { useDecodedImage, type DecodedImage } from "../lib/decoded-image";
import {
  fitImage,
  imageOriginTransform,
  previewDimension,
  type ImageBounds,
} from "../lib/lightbox-layout";
import {
  fullImgUrl,
  previewUrl,
  thumbUrl,
  trashPreviewUrl,
  trashThumbUrl,
  trashUrl,
} from "../lib/media";
import { motionTransition } from "../lib/motion";
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

function findSource(itemPath: string): HTMLImageElement | null {
  return document.querySelector<HTMLImageElement>(`[data-path="${CSS.escape(itemPath)}"] img`);
}

function sourceTransform(itemPath: string, target: ImageBounds): string | null {
  const source = findSource(itemPath)?.closest<HTMLElement>("[data-path]");
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
  const [shownPreview, setShownPreview] = useState<DecodedImage | null>(null);
  const [shownOriginal, setShownOriginal] = useState<DecodedImage | null>(null);
  const [aspect, setAspect] = useState(() => {
    const source = findSource(item.path);
    return source?.naturalWidth && source.naturalHeight
      ? source.naturalWidth / source.naturalHeight
      : item.orientation === "portrait" ? 9 / 16 : 16 / 9;
  });
  const [bounds, setBounds] = useState<ImageBounds>(() => ({
    left: 64,
    top: 56,
    width: window.innerWidth - 128,
    height: window.innerHeight - 144,
  }));
  const size = fitImage(aspect, bounds);
  const target = {
    ...size,
    left: bounds.left + (bounds.width - size.width) / 2,
    top: bounds.top + (bounds.height - size.height) / 2,
  };
  const [origin] = useState(() =>
    reducedMotion ? REST_TRANSFORM : opening
      ? sourceTransform(item.path, target) ?? "translate3d(0px, 8px, 0) scale(0.97)"
      : `translate3d(${direction * 28}px, 0px, 0) scale(1)`,
  );
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

  const dimension = previewDimension(size, window.devicePixelRatio);
  const thumbnail = context === "trash" ? trashThumbUrl(item.name) : thumbUrl(item.path);
  const preview = useDecodedImage(
    settled && isPresent
      ? context === "trash" ? trashPreviewUrl(item.name, dimension) : previewUrl(item.path, dimension)
      : null,
  );
  const original = useDecodedImage(
    originalRequested && isPresent
      ? context === "trash" ? trashUrl(item.name) : fullImgUrl(item.path)
      : null,
  );

  useEffect(() => {
    if (preview) {
      setAspect(preview.width / preview.height);
      setShownPreview(preview);
    }
  }, [preview]);

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
        initial={{ opacity: opening ? 0.7 : 0, transform: origin }}
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
              if (image.naturalHeight > 0) setAspect(image.naturalWidth / image.naturalHeight);
            }}
            className="pointer-events-auto absolute inset-0 h-full w-full rounded-lg object-contain select-none"
          />
          <AnimatePresence initial={false}>
            {[shownPreview, shownOriginal].map((image, index) => image && (
              <motion.img
                key={image.source}
                src={image.source}
                alt=""
                aria-hidden="true"
                draggable={false}
                decoding="async"
                data-lightbox-image={index === 0 ? "preview" : "original"}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={motionTransition.fast}
                className="pointer-events-none absolute inset-0 h-full w-full rounded-lg object-contain select-none"
              />
            ))}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
};
