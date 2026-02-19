// ---------------------------------------------------------------------------
// exportPng.js — Client-side PNG export for Big Five results
//
// Approach: Custom Canvas drawing (no html2canvas, no external deps).
// Canvas.toDataURL('image/png') / Canvas.toBlob('image/png') produce raw
// deflate-compressed pixel data. Browsers do NOT embed EXIF in canvas PNGs.
// The PNG spec defines optional "ancillary chunks" (tEXt, iTXt, zTXt, tIME
// etc.) that some software adds, but every major browser (Chrome, Firefox,
// Safari) writes only the mandatory chunks: IHDR, IDAT, IEND — plus a
// harmless gAMA or sRGB chunk in some builds. There is NO EXIF (which is
// a JPEG-era spec stored in PNG as an "eXIf" chunk — browsers never write
// it). The stripMetadata() helper below removes all non-essential chunks
// anyway, giving a provably clean file with zero metadata.
// ---------------------------------------------------------------------------

// Theme — mirrors style.css :root variables
const T = {
  bg:        '#1a1a2e',
  bgCard:    '#16213e',
  bgHover:   '#1f2f50',
  text:      '#e0e0e0',
  textDim:   '#8892a4',
  accent:    '#4fc3f7',
  green:     '#66bb6a',
  yellow:    '#fdd835',
  red:       '#ef5350',
  // Domain colors (must match CSS --c-* vars)
  O:         '#4fc3f7',
  C:         '#ab47bc',
  E:         '#ffa726',
  A:         '#66bb6a',
  N:         '#ef5350',
};

// Label colours for high / low / neutral
function labelStyle(result) {
  switch (result) {
    case 'high':    return { bg: 'rgba(102,187,106,0.25)', fg: T.green };
    case 'low':     return { bg: 'rgba(239,83,80,0.25)',   fg: T.red   };
    default:        return { bg: 'rgba(253,216,53,0.25)',  fg: T.yellow };
  }
}

// ---------------------------------------------------------------------------
// PNG metadata stripping
// Reads raw ArrayBuffer of a PNG file and keeps only IHDR, IDAT, IEND.
// Removes: tEXt, iTXt, zTXt, tIME, eXIf, gAMA, sRGB, cHRM, bKGD, pHYs,
// sBIT, sPLT, hIST, tRNS (non-palette), and any other ancillary chunk.
// ---------------------------------------------------------------------------
function stripPngMetadata(arrayBuffer) {
  const src  = new Uint8Array(arrayBuffer);
  const keep = new Set(['IHDR', 'IDAT', 'IEND', 'PLTE', 'tRNS']);
  // PNG signature is 8 bytes
  const sig  = src.slice(0, 8);
  const out  = [sig];
  let pos    = 8;

  while (pos < src.length) {
    // Each chunk: 4 bytes length + 4 bytes type + <length> bytes data + 4 bytes CRC
    const length = (src[pos] << 24 | src[pos+1] << 16 | src[pos+2] << 8 | src[pos+3]) >>> 0;
    const type   = String.fromCharCode(src[pos+4], src[pos+5], src[pos+6], src[pos+7]);
    const total  = 12 + length; // 4 len + 4 type + data + 4 CRC

    if (keep.has(type)) {
      out.push(src.slice(pos, pos + total));
    }
    pos += total;
  }

  // Concatenate kept chunks
  const totalLen = out.reduce((n, c) => n + c.length, 0);
  const result   = new Uint8Array(totalLen);
  let offset     = 0;
  for (const chunk of out) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------
const W           = 680;   // canvas width  (px)
const PAD         = 32;    // outer padding
const CARD_PAD    = 20;    // inner card padding
const CARD_RADIUS = 8;
const BAR_H       = 8;     // domain bar height
const FBAR_H      = 5;     // facet bar height
const FONT        = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Word-wrap text to fit within maxWidth; returns array of lines
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') { lines.push(''); continue; }
    const words = paragraph.split(/\s+/);
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function drawBar(ctx, x, y, totalW, pct, color) {
  // Track (background)
  roundRect(ctx, x, y, totalW, BAR_H, BAR_H / 2);
  ctx.fillStyle = T.bgHover;
  ctx.fill();
  // Fill
  const fillW = Math.max(BAR_H, (pct / 100) * totalW);
  roundRect(ctx, x, y, fillW, BAR_H, BAR_H / 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawFacetBar(ctx, x, y, totalW, pct, color) {
  roundRect(ctx, x, y, totalW, FBAR_H, FBAR_H / 2);
  ctx.fillStyle = T.bgHover;
  ctx.fill();
  const fillW = Math.max(FBAR_H, (pct / 100) * totalW);
  roundRect(ctx, x, y, fillW, FBAR_H, FBAR_H / 2);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.75;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawLabel(ctx, text, x, y, result) {
  const { bg, fg } = labelStyle(result);
  const label = text.toUpperCase();
  ctx.font = `600 10px ${FONT}`;
  const tw = ctx.measureText(label).width;
  const lw = tw + 14;
  const lh = 18;
  roundRect(ctx, x, y - lh / 2, lw, lh, 4);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 7, y);
  return lw;
}

// ---------------------------------------------------------------------------
// Percentile track — mirrors the on-screen pctl-track exactly
// ---------------------------------------------------------------------------
const TRACK_H = 6;

function drawPercentileTrack(ctx, x, y, totalW, percentile, color) {
  // Track background
  roundRect(ctx, x, y, totalW, TRACK_H, TRACK_H / 2);
  ctx.fillStyle = T.bgHover;
  ctx.fill();

  // Marker
  const markerR = 5;
  const markerX = x + (percentile / 100) * totalW;
  const markerY = y + TRACK_H / 2;
  ctx.beginPath();
  ctx.arc(markerX, markerY, markerR, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  return TRACK_H;
}

// ---------------------------------------------------------------------------
// Measure / draw helpers use pre-computed data from the results objects.
// No percentile or norm recalculation happens here.
// ---------------------------------------------------------------------------

// Measures total height of one domain card
function measureCard(ctx, domain) {
  const innerW = (W - PAD * 2) - CARD_PAD * 2;
  let h = CARD_PAD;         // top padding
  h += 22;                  // domain title row
  h += 6;                   // gap
  h += TRACK_H;             // percentile track
  h += 4;                   // gap
  // Ordinal label below track
  h += 14;
  h += 8;                   // gap

  // Norm context text
  if (domain.normText) {
    ctx.font = `400 11px ${FONT}`;
    const normLines = wrapText(ctx, domain.normText, innerW);
    h += normLines.length * 15;
    h += 8;
  }

  // Domain description text
  if (domain.plainText) {
    ctx.font = `400 11px ${FONT}`;
    const descLines = wrapText(ctx, domain.plainText, innerW);
    h += descLines.length * 15;
    h += 12;
  }

  // facets
  domain.facets.forEach(facet => {
    h += 14;    // facet title row
    h += 4;
    h += FBAR_H;
    // facet description text
    if (facet.plainText) {
      ctx.font = `400 10px ${FONT}`;
      const facetLines = wrapText(ctx, facet.plainText, innerW);
      h += 6 + facetLines.length * 13;
    }
    h += 10;    // gap between facets
  });
  h += CARD_PAD;            // bottom padding
  return h;
}

// Draws one domain card and returns the height consumed
function drawCard(ctx, domain, cardX, cardY, cardW) {
  const color   = T[domain.domain];
  const innerW  = cardW - CARD_PAD * 2;
  const cardH   = measureCard(ctx, domain);
  // Use the pre-computed percentile from the results page
  const percentile = domain.percentile;

  // Card background
  roundRect(ctx, cardX, cardY, cardW, cardH, CARD_RADIUS);
  ctx.fillStyle = T.bgCard;
  ctx.fill();

  // Left accent border (4 px)
  roundRect(ctx, cardX, cardY, 4, cardH, CARD_RADIUS);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillRect(cardX + 2, cardY, 2, cardH);

  let cx = cardX + CARD_PAD;
  let cy = cardY + CARD_PAD;

  // --- Domain header row ---
  // Title
  ctx.font        = `600 15px ${FONT}`;
  ctx.fillStyle   = T.text;
  ctx.textBaseline = 'middle';
  ctx.fillText(domain.title, cx, cy + 11);

  // Ordinal + label badge right-aligned on header row
  const ordStr = domain.ordinalStr;
  ctx.font = `500 11px ${FONT}`;
  ctx.fillStyle = T.textDim;
  const ordW = ctx.measureText(ordStr).width;
  // Label badge
  const labelW = (() => {
    const { bg, fg } = labelStyle(domain.scoreText);
    const label = domain.scoreText.toUpperCase();
    ctx.font = `600 10px ${FONT}`;
    const tw = ctx.measureText(label).width;
    return tw + 14;
  })();
  const badgeX = cx + innerW - labelW;
  const ordX   = badgeX - ordW - 8;
  ctx.font = `500 11px ${FONT}`;
  ctx.fillStyle = T.textDim;
  ctx.fillText(ordStr, ordX, cy + 11);
  drawLabel(ctx, domain.scoreText, badgeX, cy + 11, domain.scoreText);

  cy += 22 + 6;

  // Percentile track (matches on-screen pctl-track)
  drawPercentileTrack(ctx, cx, cy, innerW, percentile, color);
  cy += TRACK_H + 4;

  // Scale labels under track
  ctx.font = `400 9px ${FONT}`;
  ctx.fillStyle = T.textDim;
  ctx.textBaseline = 'top';
  ctx.fillText('1st', cx, cy);
  const midLabel = '50th';
  const midLabelW = ctx.measureText(midLabel).width;
  ctx.fillText(midLabel, cx + innerW / 2 - midLabelW / 2, cy);
  const rightLabel = '99th';
  const rightLabelW = ctx.measureText(rightLabel).width;
  ctx.fillText(rightLabel, cx + innerW - rightLabelW, cy);
  cy += 14 + 8;

  // Norm context text
  if (domain.normText) {
    ctx.font = `400 11px ${FONT}`;
    ctx.fillStyle = T.textDim;
    ctx.textBaseline = 'top';
    const normLines = wrapText(ctx, domain.normText, innerW);
    for (const line of normLines) {
      ctx.fillText(line, cx, cy);
      cy += 15;
    }
    cy += 8;
  }

  // Domain description text
  if (domain.plainText) {
    ctx.font = `400 11px ${FONT}`;
    ctx.fillStyle = T.textDim;
    ctx.textBaseline = 'top';
    const descLines = wrapText(ctx, domain.plainText, innerW);
    for (const line of descLines) {
      if (line === '') { cy += 8; continue; }
      ctx.fillText(line, cx, cy);
      cy += 15;
    }
    cy += 12;
  }

  // --- Facets ---
  domain.facets.forEach((facet) => {
    // Use pre-computed facet values
    const fMax = facet.fMax;
    const fPct = facet.fPct;

    // Facet title
    ctx.font        = `500 12px ${FONT}`;
    ctx.fillStyle   = T.text;
    ctx.textBaseline = 'middle';
    ctx.fillText(facet.title, cx, cy + 7);

    // Facet score (right-aligned)
    const scoreStr = `${facet.score}/${fMax}`;
    ctx.font      = `400 11px ${FONT}`;
    ctx.fillStyle = T.textDim;
    const scoreW  = ctx.measureText(scoreStr).width;
    ctx.fillText(scoreStr, cx + innerW - scoreW, cy + 7);

    cy += 14 + 4;

    // Facet bar (full width)
    drawFacetBar(ctx, cx, cy, innerW, fPct, color);
    cy += FBAR_H;

    // Facet description text
    if (facet.plainText) {
      cy += 6;
      ctx.font = `400 10px ${FONT}`;
      ctx.fillStyle = T.textDim;
      ctx.textBaseline = 'top';
      const facetLines = wrapText(ctx, facet.plainText, innerW);
      for (const line of facetLines) {
        if (line === '') { cy += 6; continue; }
        ctx.fillText(line, cx, cy);
        cy += 13;
      }
    }

    cy += 10;
  });

  return cardH;
}

// ---------------------------------------------------------------------------
// Main export function
// Receives the enriched results array from renderResults() — all percentiles,
// normative context, and plain-text descriptions are pre-computed.
// ---------------------------------------------------------------------------
export function exportResultsPng(results) {
  // ------------------------------------------------------------------
  // 1. Pre-compute total canvas height
  // ------------------------------------------------------------------
  const titleH   = 60;   // "Your Results" section
  const cardGap  = 12;
  const footerH  = 36;
  const tempCtx  = document.createElement('canvas').getContext('2d');
  const cardW    = W - PAD * 2;

  let totalH = PAD + titleH;
  results.forEach(domain => {
    totalH += measureCard(tempCtx, domain) + cardGap;
  });
  totalH += footerH + PAD;

  // ------------------------------------------------------------------
  // 2. Create canvas
  // ------------------------------------------------------------------
  const dpr    = Math.min(window.devicePixelRatio || 1, 2); // cap at 2x
  const canvas = document.createElement('canvas');
  canvas.width  = W * dpr;
  canvas.height = totalH * dpr;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // ------------------------------------------------------------------
  // 3. Background
  // ------------------------------------------------------------------
  ctx.fillStyle = T.bg;
  ctx.fillRect(0, 0, W, totalH);

  // ------------------------------------------------------------------
  // 4. Title
  // ------------------------------------------------------------------
  let y = PAD;
  ctx.font        = `700 22px ${FONT}`;
  ctx.fillStyle   = T.text;
  ctx.textBaseline = 'top';
  ctx.fillText('Your Results', PAD, y);

  ctx.font        = `400 13px ${FONT}`;
  ctx.fillStyle   = T.textDim;
  ctx.fillText('Big Five Personality Test', PAD, y + 28);

  y += titleH;

  // ------------------------------------------------------------------
  // 5. Domain cards
  // ------------------------------------------------------------------
  results.forEach(domain => {
    const h = drawCard(ctx, domain, PAD, y, cardW);
    y += h + cardGap;
  });

  // ------------------------------------------------------------------
  // 6. Footer
  // ------------------------------------------------------------------
  y += 4;
  ctx.font        = `400 11px ${FONT}`;
  ctx.fillStyle   = T.textDim;
  ctx.textBaseline = 'top';
  ctx.fillText('bigfive-test · Runs entirely in your browser · No data leaves this device', PAD, y);

  // ------------------------------------------------------------------
  // 7. Export → strip metadata → download
  // ------------------------------------------------------------------
  canvas.toBlob(blob => {
    blob.arrayBuffer().then(buf => {
      const clean     = stripPngMetadata(buf);
      const cleanBlob = new Blob([clean], { type: 'image/png' });
      const url       = URL.createObjectURL(cleanBlob);
      const a         = document.createElement('a');
      a.href          = url;
      a.download      = 'bigfive-results.png';
      a.click();
      // Revoke after a short delay to allow the download to start
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    });
  }, 'image/png');
}
