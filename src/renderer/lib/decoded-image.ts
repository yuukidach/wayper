import { useEffect, useState } from "react";

export interface DecodedImage {
  source: string;
  width: number;
  height: number;
}

export function useDecodedImage(source: string | null): DecodedImage | null {
  const [decoded, setDecoded] = useState<DecodedImage | null>(null);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    const image = new Image();
    image.decoding = "async";
    image.src = source;
    void image.decode()
      .then(() => {
        if (!cancelled && image.naturalWidth > 0 && image.naturalHeight > 0) {
          setDecoded({ source, width: image.naturalWidth, height: image.naturalHeight });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      image.src = "";
    };
  }, [source]);

  return decoded?.source === source ? decoded : null;
}
