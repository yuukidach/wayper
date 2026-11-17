import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useDecodedImage } from "../lib/decoded-image";
import { motionTransition } from "../lib/motion";

interface CrossfadeImageProps {
  src: string;
  className?: string;
}

export const CrossfadeImage: React.FC<CrossfadeImageProps> = ({ src, className = "" }) => {
  const decoded = useDecodedImage(src);
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (decoded) setShown(decoded.source);
  }, [decoded]);

  return (
    <span className={`relative block h-full w-full overflow-hidden ${className}`}>
      <AnimatePresence initial={false}>
        {shown && (
          <motion.img
            key={shown}
            src={shown}
            alt=""
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={motionTransition.normal}
            className="absolute inset-0 h-full w-full object-cover"
            decoding="async"
            draggable={false}
          />
        )}
      </AnimatePresence>
    </span>
  );
};
