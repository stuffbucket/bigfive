// ---------------------------------------------------------------------------
// QR code generation — uses vendored nayuki qrcodegen (~4KB gzip)
// with a minimal path-based SVG renderer (no per-rect bloat).
// Bundled statically so no network requests occur at runtime.
// ---------------------------------------------------------------------------

import qrcodegen from './vendor/qrcodegen.js';

const QrCode = qrcodegen.QrCode;

/**
 * Generate an SVG string containing a QR code for the given text.
 * Uses a single <path> element — no per-module rects.
 *
 * @param {string} text - The text/URL to encode.
 * @param {object} opts
 * @param {number} opts.border - Quiet zone in modules (default 4, spec minimum).
 * @param {string} opts.lightColor - Background fill (default white).
 * @param {string} opts.darkColor  - Module fill (default black).
 * @returns {string} SVG markup string.
 */
export function generateQRSvg(text, { border = 4, lightColor = '#ffffff', darkColor = '#000000' } = {}) {
  const qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
  const size = qr.size;
  const total = size + border * 2;

  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (qr.getModule(x, y)) {
        d += `M${x + border},${y + border}h1v1h-1z`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR code">`
    + `<rect width="100%" height="100%" fill="${lightColor}"/>`
    + `<path fill="${darkColor}" d="${d}"/>`
    + `</svg>`;
}
