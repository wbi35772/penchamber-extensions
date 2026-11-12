/**
 * Extension logos are shipped as small SVG data URLs. Some use
 * `fill="currentColor"` or a hard-coded stroke, so inside an <img> they resolve
 * to black or white ink with a transparent backdrop. Every logo tile now uses
 * one light chip, so a white monochrome glyph would vanish: measure the decoded
 * image and invert only those.
 *
 * The tile surface is fixed, not theme-dependent, which keeps the library and
 * the marketplace visually identical in light and dark host themes.
 */

interface IconStats {
  /** Alpha-weighted mean luminance of the visible pixels (0..1). */
  luminance: number;
  /** Largest per-pixel channel spread, averaged over visible pixels (0..255). */
  spread: number;
}

const channel = (value: number): number => {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
};

const stats = (img: HTMLImageElement): IconStats | null => {
  const width = img.naturalWidth || 32;
  const height = img.naturalHeight || 32;
  if (!width || !height) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(img, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    let weighted = 0;
    let alphaSum = 0;
    let spreadSum = 0;
    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3] / 255;
      if (alpha < 0.16) continue;
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      weighted += (0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)) * alpha;
      spreadSum += (Math.max(red, green, blue) - Math.min(red, green, blue)) * alpha;
      alphaSum += alpha;
    }
    if (alphaSum <= 0) return null;
    return { luminance: weighted / alphaSum, spread: spreadSum / alphaSum };
  } catch {
    return null;
  }
};

const mark = (img: HTMLImageElement): void => {
  const tile = img.parentElement;
  if (!tile) return;
  const value = stats(img);
  if (!value) return;
  // Only a near-greyscale, near-white glyph needs the invert. Colourful logos
  // and dark monochrome glyphs already read on the light chip.
  const monochrome = value.spread < 20;
  tile.classList.toggle('guest-icon-ink-light', monochrome && value.luminance > 0.62);
};

const scheduleMark = (img: HTMLImageElement, attempts = 4): void => {
  requestAnimationFrame(() => {
    if (!img.isConnected) {
      if (attempts > 0) scheduleMark(img, attempts - 1);
      return;
    }
    mark(img);
  });
};

export const ensureIconContrast = (img: HTMLImageElement): void => {
  scheduleMark(img);
  if (img.complete && img.naturalWidth > 0) {
    mark(img);
    return;
  }
  img.addEventListener(
    'load',
    () => {
      mark(img);
      scheduleMark(img);
    },
    { once: true },
  );
};
