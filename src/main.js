import './style.css';
import allQuestions from './data/questions.json';
import allResults from './data/results.json';
import languages from './data/languages.json';
import { exportResultsPng } from './exportPng.js';
import { generateQRSvg } from './qr.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  lang: localStorage.getItem('b5-lang') || 'en',
  currentQuestion: 0,
  answers: JSON.parse(localStorage.getItem('b5-progress') || 'null'),
  results: null
};

// ---------------------------------------------------------------------------
// Scoring (reimplemented — 15 lines, no dependency)
// ---------------------------------------------------------------------------
function calculateScores(answers, questions) {
  const scores = {};
  answers.forEach((score, i) => {
    const q = questions[i];
    const d = q.domain;
    const f = q.facet;
    if (!scores[d]) scores[d] = { score: 0, count: 0, result: 'neutral', facet: {} };
    scores[d].score += score;
    scores[d].count += 1;
    if (!scores[d].facet[f]) scores[d].facet[f] = { score: 0, count: 0, result: 'neutral' };
    scores[d].facet[f].score += score;
    scores[d].facet[f].count += 1;
  });
  for (const d of Object.values(scores)) {
    d.result = classify(d.score, d.count);
    for (const f of Object.values(d.facet)) f.result = classify(f.score, f.count);
  }
  return scores;
}

function classify(score, count) {
  const avg = score / count;
  return avg > 3 ? 'high' : avg < 3 ? 'low' : 'neutral';
}

// ---------------------------------------------------------------------------
// Results generation (maps scores onto template text)
// ---------------------------------------------------------------------------
function generateResults(scores, lang) {
  const template = allResults[lang] || allResults['en'];
  return template.map(domain => {
    const ds = scores[domain.domain];
    if (!ds) return null;
    const resultText = domain.results.find(r => r.score === ds.result);
    const facets = domain.facets.map(f => {
      const fs = ds.facet[f.facet.toString()] || {};
      return { ...f, score: fs.score || 0, count: fs.count || 0, scoreText: fs.result || 'neutral' };
    }).filter(f => f.score);
    return {
      domain: domain.domain,
      title: domain.title,
      shortDescription: domain.shortDescription,
      description: domain.description,
      score: ds.score,
      count: ds.count,
      scoreText: ds.result,
      text: resultText ? resultText.text : '',
      facets
    };
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Sharing: encode/decode facet scores into a compact URL hash
//
// ENCODING SCHEME (v2)
// --------------------
// Data: 30 facet scores, each in the range [4, 20] (17 possible values).
//
// Step 1 — subtract the minimum to get values in [0, 16].
//   17 values fit in 5 bits (2^5 = 32 >= 17).
//
// Step 2 — bit-pack: write each value MSB-first into a contiguous bit stream.
//   30 values × 5 bits = 150 bits = 18.75 → 19 bytes (2 trailing zero-pad bits).
//
// Step 3 — base64url-encode the 19 bytes without padding characters.
//   19 bytes → ceil(19 × 4/3) = 26 base64url characters.
//
// Step 4 — embed in the URL hash with a /v2/ version prefix that
//   cleanly disambiguates from old-format URLs:
//   New: #/results/v2/<lang>/<26-char base64url>   (e.g. 42 chars for "en")
//   Old: #/results/<lang>/<120 digits>              (e.g. 133 chars for "en")
//
// FACET ORDER in the bit stream (matches DOMAIN_ORDER = ['O','C','E','A','N']):
//   O1 O2 O3 O4 O5 O6  C1 C2 C3 C4 C5 C6  E1 E2 E3 E4 E5 E6
//   A1 A2 A3 A4 A5 A6  N1 N2 N3 N4 N5 N6
//
// BACKWARD COMPATIBILITY
// ----------------------
// decodeHash() still recognises the old digit-string format and returns
// { lang, answers } so that renderResults() can fall back to the
// calculateScores(answers, questions) path for old links.
//
// New links carry { lang, facetScores } instead, and renderResults()
// reconstructs the full scores object directly from the facet scores
// without needing the questions array at all.
//
// localStorage migration: on "See Results" the app now saves
// { facetScores, lang } alongside the old { answers, lang } entry so
// that "View Last Results" on the home page always generates a v2 URL.
// ---------------------------------------------------------------------------

const DOMAIN_ORDER_ENCODE = ['O', 'C', 'E', 'A', 'N'];
const FACETS_PER_DOMAIN   = 6;
const QUESTIONS_PER_FACET = 4;   // always 4 — fixed by the IPIP-NEO-PI-R design
const FACET_MIN           = 4;   // minimum possible facet score (4 × 1)
const FACET_MAX           = 20;  // maximum possible facet score (4 × 5)
const FACET_BITS          = 5;   // ceil(log2(FACET_MAX - FACET_MIN + 1)) = ceil(log2(17)) = 5
const FACET_COUNT         = DOMAIN_ORDER_ENCODE.length * FACETS_PER_DOMAIN; // 30
const PAYLOAD_BYTES       = Math.ceil(FACET_COUNT * FACET_BITS / 8);        // 19

/**
 * Pack 30 facet scores (each 4–20) into a 19-byte Uint8Array.
 * Values are offset by FACET_MIN so each fits in FACET_BITS bits,
 * then written MSB-first into a contiguous bit stream.
 *
 * @param {number[]} facetScores - Array of 30 integers in [4, 20],
 *   ordered O1–O6, C1–C6, E1–E6, A1–A6, N1–N6.
 * @returns {Uint8Array} 19-byte packed buffer.
 */
function packFacetScores(facetScores) {
  const bytes = new Uint8Array(PAYLOAD_BYTES);
  let bitPos = 0;
  for (const score of facetScores) {
    const val = score - FACET_MIN; // 0–16
    for (let b = FACET_BITS - 1; b >= 0; b--) {
      const bit      = (val >> b) & 1;
      const byteIdx  = bitPos >> 3;          // Math.floor(bitPos / 8)
      const bitShift = 7 - (bitPos & 7);     // MSB of current byte first
      bytes[byteIdx] |= (bit << bitShift);
      bitPos++;
    }
  }
  return bytes;
}

/**
 * Unpack a 19-byte Uint8Array back into 30 facet scores in [4, 20].
 * Inverse of packFacetScores.
 *
 * @param {Uint8Array} bytes
 * @returns {number[]} Array of 30 integers in [4, 20].
 */
function unpackFacetScores(bytes) {
  const scores = [];
  let bitPos = 0;
  for (let i = 0; i < FACET_COUNT; i++) {
    let val = 0;
    for (let b = FACET_BITS - 1; b >= 0; b--) {
      const byteIdx  = bitPos >> 3;
      const bitShift = 7 - (bitPos & 7);
      val |= (((bytes[byteIdx] >> bitShift) & 1) << b);
      bitPos++;
    }
    scores.push(val + FACET_MIN);
  }
  return scores;
}

/**
 * Encode a Uint8Array as a URL-safe base64 string (no padding characters).
 * Uses the standard btoa() path available in all browsers.
 *
 * @param {Uint8Array} bytes
 * @returns {string} base64url string (characters: A-Z a-z 0-9 - _)
 */
function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Decode a URL-safe base64 string (with or without padding) to a Uint8Array.
 *
 * @param {string} str
 * @returns {Uint8Array}
 */
function fromBase64Url(str) {
  // Restore standard base64 characters and padding
  const pad    = str.length % 4;
  const padded = pad ? str + '='.repeat(4 - pad) : str;
  const b64    = padded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Extract 30 facet scores from the scores object produced by calculateScores().
 * Scores are emitted in OCEAN × facet-1-through-6 order.
 *
 * @param {object} scores - Output of calculateScores().
 * @returns {number[]} Array of 30 integers in [4, 20].
 */
function extractFacetScores(scores) {
  const result = [];
  for (const domain of DOMAIN_ORDER_ENCODE) {
    for (let f = 1; f <= FACETS_PER_DOMAIN; f++) {
      result.push(scores[domain].facet[String(f)].score);
    }
  }
  return result;
}

/**
 * Reconstruct the full scores object from 30 facet scores alone.
 * Because questions-per-facet is a fixed constant (4), all counts,
 * domain totals, and high/neutral/low classifications are fully
 * deterministic — no question data required.
 *
 * @param {number[]} facetScores - Array of 30 integers in [4, 20],
 *   ordered O1–O6, C1–C6, E1–E6, A1–A6, N1–N6.
 * @returns {object} Scores object compatible with generateResults().
 */
function facetScoresToScores(facetScores) {
  const scores = {};
  let idx = 0;
  for (const domain of DOMAIN_ORDER_ENCODE) {
    const domainCount = FACETS_PER_DOMAIN * QUESTIONS_PER_FACET; // 24
    scores[domain] = { score: 0, count: domainCount, result: 'neutral', facet: {} };
    for (let f = 1; f <= FACETS_PER_DOMAIN; f++) {
      const fs = facetScores[idx++];
      scores[domain].facet[String(f)] = {
        score:  fs,
        count:  QUESTIONS_PER_FACET,
        result: classify(fs, QUESTIONS_PER_FACET)
      };
      scores[domain].score += fs;
    }
    scores[domain].result = classify(scores[domain].score, domainCount);
  }
  return scores;
}

/**
 * Encode 30 facet scores + language into a v2 URL hash fragment.
 * The hash is safe to use directly as location.hash or in an <a href>.
 *
 * Output format: #/results/v2/<lang>/<26-char base64url>
 * Example (en):  #/results/v2/en/AEQyFMdCVLY1z4ACIZCmOhKlsA
 *
 * @param {number[]} facetScores - Array of 30 integers in [4, 20].
 * @param {string}   lang        - BCP-47 language tag, e.g. "en" or "zh-hant".
 * @returns {string} URL hash fragment beginning with "#".
 */
function encodeFacetScores(facetScores, lang) {
  const packed  = packFacetScores(facetScores);
  const payload = toBase64Url(packed);
  return `#/results/v2/${lang}/${payload}`;
}

/**
 * Decode a URL hash fragment into its language and either facet scores (v2)
 * or raw answers (v1 legacy).
 *
 * Returns one of:
 *   { lang, facetScores }  — for v2 hashes (new format)
 *   { lang, answers }      — for v1 hashes (old 120-digit format)
 *   null                   — if the hash is unrecognised or invalid
 *
 * @param {string} hash - The full location.hash string.
 * @returns {{ lang: string, facetScores: number[] }
 *          |{ lang: string, answers: number[] }
 *          |null}
 */
function decodeHash(hash) {
  // ── v2: #/results/v2/<lang>/<base64url> ──────────────────────────────────
  const v2 = hash.match(/^#\/results\/v2\/([a-z][a-z0-9-]*)\/([A-Za-z0-9_-]+)$/);
  if (v2) {
    const lang    = v2[1];
    const payload = v2[2];
    let bytes;
    try {
      bytes = fromBase64Url(payload);
    } catch {
      return null; // malformed base64
    }
    if (bytes.length < PAYLOAD_BYTES) return null; // truncated
    const facetScores = unpackFacetScores(bytes);
    // Validate every score is in the legal range
    if (!facetScores.every(s => s >= FACET_MIN && s <= FACET_MAX)) return null;
    return { lang, facetScores };
  }

  // ── v1 (legacy): #/results/<lang>/<120 digits 1–5> ───────────────────────
  const v1 = hash.match(/^#\/results\/([a-z][a-z0-9-]*)\/([1-5]{120})$/);
  if (v1) {
    return { lang: v1[1], answers: v1[2].split('').map(Number) };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function getRoute() {
  const hash = location.hash || '#/';
  if (hash === '#/' || hash === '#' || hash === '') return 'home';
  if (hash === '#/test') return 'test';
  if (hash === '#/privacy') return 'privacy';
  if (hash === '#/about') return 'about';
  if (hash.startsWith('#/results/')) return 'results';
  return 'home';
}

function navigate(hash) {
  location.hash = hash;
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------
const app = document.getElementById('app');
const DOMAIN_ORDER = ['O', 'C', 'E', 'A', 'N'];
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (typeof c === 'string') el.appendChild(document.createTextNode(c));
    else if (c) el.appendChild(c);
  }
  return el;
}

function renderHeader() {
  const langOptions = Object.entries(languages).map(([id, name]) =>
    h('option', { value: id, ...(id === state.lang ? { selected: '' } : {}) }, name)
  );
  const select = h('select', {
    className: 'lang-select',
    onChange: (e) => {
      state.lang = e.target.value;
      localStorage.setItem('b5-lang', state.lang);
      render();
    }
  }, ...langOptions);

  return h('header', {},
    h('h1', { onClick: () => navigate('#/') }, 'Big Five'),
    h('nav', {},
      h('a', { href: '#/test' }, 'Test'),
      h('a', { href: '#/privacy' }, 'Privacy'),
      h('a', { href: '#/about' }, 'About'),
      select
    )
  );
}

function renderFooter() {
  const labLink = h('a', { href: 'https://www.ocf.berkeley.edu/~johnlab/measures.html', target: '_blank', rel: 'noopener' }, 'Berkeley Personality Lab');
  return h('footer', {},
    h('p', {}, 'Runs entirely in your browser. No data leaves this device.'),
    h('p', { style: { marginTop: '0.25rem' } }, 'Based on ', h('a', { href: 'https://ipip.ori.org/', target: '_blank', rel: 'noopener' }, 'IPIP-NEO-PI-R'), '. See also: ', labLink, '.'),
    h('p', { style: { marginTop: '0.25rem' } }, h('a', { href: '#/about' }, 'About & Licenses'))
  );
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
function renderHome() {
  const hasPrevious = !!localStorage.getItem('b5-results');
  const hasProgress = !!state.answers;

  const buttons = h('div', { style: { display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' } });

  if (hasProgress) {
    buttons.appendChild(h('a', { className: 'btn', href: '#/test' }, 'Continue Test'));
    buttons.appendChild(h('button', {
      className: 'btn btn--outline btn--sm',
      onClick: () => { state.answers = null; state.currentQuestion = 0; localStorage.removeItem('b5-progress'); navigate('#/test'); }
    }, 'Start Over'));
  } else {
    buttons.appendChild(h('a', { className: 'btn', href: '#/test' }, 'Take the Test'));
  }

  if (hasPrevious) {
    const saved = JSON.parse(localStorage.getItem('b5-results'));
    // Prefer the compact v2 URL; fall back to raw-answers if only old data present
    const href = saved.facetScores
      ? encodeFacetScores(saved.facetScores, saved.lang)
      : `#/results/${saved.lang}/${saved.answers.join('')}`;
    buttons.appendChild(h('a', { className: 'btn btn--outline', href }, 'View Last Results'));
  }

  const features = h('div', { className: 'features' },
    h('div', { className: 'feature' },
      h('h3', {}, 'Offline'),
      h('p', {}, 'Your browser saves the entire app on first visit. Come back anytime — even on a plane — and it still works.')
    ),
    h('div', { className: 'feature' },
      h('h3', {}, 'Private'),
      h('p', {}, 'No cookies, no tracking, no data sent anywhere. Your answers stay on your device and nowhere else. ', h('a', { href: '#/privacy' }, 'See how we prove it.'))
    ),
    h('div', { className: 'feature' },
      h('h3', {}, 'Scientific'),
      h('p', {}, '120-item IPIP-NEO-PI-R inventory measuring 5 domains and 30 facets.')
    ),
    h('div', { className: 'feature' },
      h('h3', {}, '42 Languages'),
      h('p', {}, 'Community translations included. Select your language from the header.')
    )
  );

  return h('div', {},
    h('div', { className: 'hero' },
      h('h2', {}, 'Big Five Personality Test'),
      h('p', { className: 'subtitle' }, '120 questions. 10 minutes. Completely private — nothing leaves your browser.'),
      buttons
    ),
    features
  );
}

function renderTest() {
  const questions = allQuestions[state.lang] || allQuestions['en'];
  if (!state.answers) {
    state.answers = new Array(questions.length).fill(0);
    state.currentQuestion = 0;
  }

  const idx = state.currentQuestion;
  const q = questions[idx];
  const total = questions.length;
  const answered = state.answers.filter(a => a > 0).length;

  const progress = h('div', { className: 'progress-wrap' },
    h('div', { className: 'progress-bar' },
      h('div', { className: 'progress-fill', style: { width: `${(answered / total) * 100}%` } })
    ),
    h('div', { className: 'progress-text' },
      h('span', {}, `Question ${idx + 1} of ${total}`),
      h('span', {}, `${answered} answered`)
    )
  );

  const choices = h('div', { className: 'choices' });
  q.choices.forEach(choice => {
    const btn = h('button', {
      className: `choice${state.answers[idx] === choice.score ? ' selected' : ''}`,
      onClick: () => {
        state.answers[idx] = choice.score;
        localStorage.setItem('b5-progress', JSON.stringify(state.answers));
        // Auto-advance after short delay
        setTimeout(() => {
          if (idx < total - 1) {
            state.currentQuestion = idx + 1;
            render();
          } else {
            render(); // Re-render to show finish button
          }
        }, 200);
        render(); // Immediate render for selection highlight
      }
    }, choice.text);
    choices.appendChild(btn);
  });

  const card = h('div', { className: 'question-card' },
    h('div', { className: 'question-num' }, `${idx + 1} / ${total}`),
    h('div', { className: 'question-text' }, q.text),
    choices
  );

  const nav = h('div', { className: 'test-nav' });

  if (idx > 0) {
    nav.appendChild(h('button', {
      className: 'btn btn--outline btn--sm',
      onClick: () => { state.currentQuestion = idx - 1; render(); }
    }, 'Back'));
  } else {
    nav.appendChild(h('span'));
  }

  const allAnswered = state.answers.every(a => a > 0);

  if (idx < total - 1) {
    nav.appendChild(h('button', {
      className: 'btn btn--sm',
      onClick: () => { state.currentQuestion = idx + 1; render(); }
    }, 'Skip'));
  } else if (allAnswered) {
    nav.appendChild(h('button', {
      className: 'btn',
      onClick: () => {
        const questions   = allQuestions[state.lang] || allQuestions['en'];
        const scores      = calculateScores(state.answers, questions);
        const facetScores = extractFacetScores(scores);
        // Persist both formats: facetScores for v2 URLs, answers for any future
        // tooling that might need to recompute from raw responses.
        localStorage.setItem('b5-results', JSON.stringify({
          answers:     state.answers,
          facetScores,
          lang:        state.lang
        }));
        localStorage.removeItem('b5-progress');
        navigate(encodeFacetScores(facetScores, state.lang));
      }
    }, 'See Results'));
  } else {
    const unanswered = state.answers.reduce((acc, a, i) => a === 0 ? [...acc, i] : acc, []);
    nav.appendChild(h('button', {
      className: 'btn btn--outline btn--sm',
      onClick: () => {
        state.currentQuestion = unanswered[0];
        render();
      }
    }, `${unanswered.length} unanswered — go to first`));
  }

  return h('div', { className: 'test-container' }, progress, card, nav);
}

function renderResults() {
  const decoded = decodeHash(location.hash);

  // Validate: decoded must be non-null and carry either facetScores (v2) or
  // a full set of 120 answers (v1 legacy).
  const isV2 = decoded && Array.isArray(decoded.facetScores) && decoded.facetScores.length === FACET_COUNT;
  const isV1 = decoded && Array.isArray(decoded.answers)     && decoded.answers.length     === 120;

  if (!isV2 && !isV1) {
    return h('div', {},
      h('h2', {}, 'Invalid results link'),
      h('p', {}, 'The URL doesn\'t contain valid test data.'),
      h('a', { href: '#/test', className: 'btn', style: { marginTop: '1rem', display: 'inline-block' } }, 'Take the Test')
    );
  }

  const { lang } = decoded;
  // v2: reconstruct scores directly from facet scores — no question data needed.
  // v1: score the raw answers the traditional way (full backward compatibility).
  const scores = isV2
    ? facetScoresToScores(decoded.facetScores)
    : calculateScores(decoded.answers, allQuestions[lang] || allQuestions['en']);
  const results = generateResults(scores, lang);

  // Sort by OCEAN order
  results.sort((a, b) => DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain));

  const header = h('div', { className: 'results-header' },
    h('h2', {}, 'Your Results'),
    h('p', {}, 'Click any trait to expand details and facet scores.')
  );

  const cards = h('div', {});
  results.forEach(domain => {
    const maxScore = domain.count * 5;
    const pct = (domain.score / maxScore) * 100;
    const color = `var(--c-${domain.domain})`;

    const body = h('div', { className: 'domain-body' });

    // Description
    body.appendChild(h('div', { className: 'domain-desc' }));
    body.lastChild.innerHTML = domain.text;

    // Facets
    domain.facets.forEach(facet => {
      const fMax = facet.count * 5;
      const fPct = (facet.score / fMax) * 100;
      const facetEl = h('div', { className: 'facet' },
        h('div', { className: 'facet-header' },
          h('span', { className: 'facet-title' }, facet.title),
          h('span', { className: 'facet-score' }, `${facet.score}/${fMax}`)
        ),
        h('div', { className: 'facet-bar' },
          h('div', { className: 'facet-bar-fill', style: { width: `${fPct}%`, background: color } })
        )
      );
      if (facet.text) {
        const textEl = h('div', { className: 'facet-text' });
        textEl.innerHTML = facet.text;
        facetEl.appendChild(textEl);
      }
      body.appendChild(facetEl);
    });

    const card = h('div', { className: 'domain-card', style: { '--domain-color': color } },
      h('div', {
        className: 'domain-header',
        onClick: () => body.classList.toggle('open')
      },
        h('span', { className: 'domain-title' }, domain.title),
        h('div', { className: 'domain-score-wrap' },
          h('div', { className: 'domain-bar' },
            h('div', { className: 'domain-bar-fill', style: { width: `${pct}%` } })
          ),
          h('span', { className: `domain-label ${domain.scoreText}` }, domain.scoreText)
        )
      ),
      body
    );
    cards.appendChild(card);
  });

  // Share section
  const shareUrl = location.href;
  const shareInput = h('input', { type: 'text', value: shareUrl, readonly: '' });
  const toast = h('div', { className: 'copy-toast' }, 'Copied!');
  const share = h('div', { className: 'share-section' },
    h('h3', {}, 'Share your results'),
    h('p', {
      style: { fontSize: '0.85rem', color: 'var(--text-dim)', marginBottom: '0.75rem' }
    }, 'Your 30 facet scores are encoded directly in the URL — no server stores anything. No individual answers or personal information are included. ',
      h('a', { href: '#/privacy', style: { fontSize: '0.85rem' } }, 'Learn more.')),
    h('div', { className: 'share-url' },
      shareInput,
      h('button', {
        className: 'btn btn--sm',
        onClick: () => {
          navigator.clipboard.writeText(shareUrl).then(() => {
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 2000);
          });
        }
      }, 'Copy')
    ),
    toast
  );

  // QR code (lazy-loaded on demand)
  const qrContainer = h('div', { style: { display: 'none', marginTop: '0.75rem', textAlign: 'center' } });
  const qrBtn = h('button', {
    className: 'btn btn--sm btn--outline',
    style: { marginTop: '0.75rem' },
    onClick: async () => {
      if (qrContainer.style.display !== 'none') {
        qrContainer.style.display = 'none';
        qrBtn.textContent = 'Show QR Code';
        return;
      }
      const svg = generateQRSvg(shareUrl);
      qrContainer.innerHTML = svg;
      qrContainer.querySelector('svg').style.cssText = 'width:160px;height:160px;display:inline-block;border-radius:4px;';
      qrContainer.style.display = 'block';
      qrBtn.textContent = 'Hide QR Code';
    }
  }, 'Show QR Code');
  share.appendChild(qrBtn);
  share.appendChild(qrContainer);

  const retake = h('div', { style: { textAlign: 'center', marginTop: '1rem', display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' } },
    h('a', {
      href: '#/test',
      className: 'btn btn--outline',
      onClick: () => { state.answers = null; state.currentQuestion = 0; localStorage.removeItem('b5-progress'); }
    }, 'Take Again'),
    h('button', {
      className: 'btn btn--outline',
      onClick: () => exportResultsPng(results)
    }, 'Save as PNG')
  );

  return h('div', {}, header, cards, share, retake);
}

// ---------------------------------------------------------------------------
// Privacy / Verify page
// ---------------------------------------------------------------------------
function renderPrivacy() {
  const section = (title, ...children) => {
    const s = h('div', { className: 'privacy-section' },
      h('h3', {}, title)
    );
    children.forEach(c => s.appendChild(c));
    return s;
  };

  const p = (text) => h('p', { className: 'privacy-p' }, text);

  const page = h('div', { className: 'privacy-page' },
    h('h2', {}, 'Your Privacy'),
    h('p', { className: 'privacy-intro' }, 'This app was built with one rule: your information is yours alone. Nothing about you is collected, stored on a server, or shared with anyone. Here is exactly how it works.')
  );

  // ── Section 1: What's saved on your device ──────────────────────────────
  page.appendChild(section("What's saved on your device",
    p('This app saves a few small notes inside your browser — and only inside your browser. Think of it like a sticky note your browser keeps for itself. No one else can see it.'),
    h('ul', { className: 'privacy-list' },
      h('li', {}, 'Your language choice — so it remembers you prefer English (or whichever language you picked).'),
      h('li', {}, 'Your in-progress answers — so if you close the page mid-test, you can pick up where you left off. These are automatically deleted when you finish.'),
      h('li', {}, 'Your most recent results — so you can come back and view them later without retaking the test.')
    ),
    p('That is everything. There is no account. There is no server saving your data. There are no cookies. The information lives in your browser on your device, and nowhere else.')
  ));

  // ── Section 2: What we DON'T collect ────────────────────────────────────
  page.appendChild(section("What we DON'T collect",
    p('Most websites track you with cookies and send data to advertising companies. This one does not. Specifically, we do not collect:'),
    h('ul', { className: 'privacy-list' },
      h('li', {}, 'Your name or email address'),
      h('li', {}, 'Your IP address or location'),
      h('li', {}, 'Your browsing history'),
      h('li', {}, 'Any cookies or tracking data'),
      h('li', {}, 'Any analytics or usage statistics'),
      h('li', {}, 'Your test answers or personality results')
    ),
    p('There is no tracking code on this page. No advertising company knows you are here. Your test answers exist only on your device, and if you choose to share your results, they are encoded directly into the link itself — still no server involved.')
  ));

  // ── Section 3: How this app stays on your phone/computer ────────────────
  page.appendChild(section('How this app stays on your phone or computer',
    p('The first time you visit, your browser saves a complete copy of this app — like downloading a file. After that, when you come back, it loads the saved copy instead of downloading it again. That is why it works even without an internet connection.'),
    p('This saved copy will stay on your device until one of these things happens:'),
    h('ul', { className: 'privacy-list' },
      h('li', {}, 'You clear your browser data (history, cache, etc.)'),
      h('li', {}, 'You use the "Delete everything" button at the bottom of this page'),
      h('li', {}, 'On iPhones and iPads, if you have not visited in about a week and you have not added the app to your Home Screen, your browser may clean up the saved copy automatically. You can always come back and it will re-save itself.')
    ),
    p('For the best experience, you can add this app to your Home Screen. On iPhones, tap the Share button, then "Add to Home Screen." On Android, tap the menu and choose "Install App." This makes it behave like a regular app that is always available.')
  ));

  // ── Section 4: Visual self-test ─────────────────────────────────────────
  const checkContainer = h('div', { className: 'privacy-checks' });
  const overallResult = h('div', { className: 'privacy-overall-result' });

  const checks = [
    {
      label: 'No cookies found',
      explanation: 'Cookies are small files websites use to track you. This app uses none.',
      test: () => {
        // Check that no cookies are set for this site
        return document.cookie.length === 0;
      }
    },
    {
      label: 'No tracking scripts',
      explanation: 'Many websites load code from Google, Facebook, or ad companies. This app loads nothing from other websites.',
      test: () => {
        // Check that no external scripts are loaded
        const scripts = Array.from(document.querySelectorAll('script[src]'));
        return scripts.every(s => {
          try { return new URL(s.src).origin === location.origin; }
          catch { return true; }
        });
      }
    },
    {
      label: 'Network requests blocked',
      explanation: 'This app tells your browser to block any attempt to send data to the internet.',
      test: async () => {
        try {
          await fetch('https://example.com', { mode: 'no-cors', cache: 'no-store' });
          return false; // Request went through — not blocked
        } catch {
          return true; // Blocked as expected
        }
      }
    },
    {
      label: 'No external connections',
      explanation: 'No images, fonts, or files are loaded from other websites. Everything comes from the saved copy on your device.',
      test: () => {
        // Check that no external resources are referenced
        const links = Array.from(document.querySelectorAll('link[href]'));
        const imgs = Array.from(document.querySelectorAll('img[src]'));
        const allEls = [...links, ...imgs];
        return allEls.every(el => {
          const url = el.href || el.src;
          if (!url || url.startsWith('data:') || url.startsWith('blob:')) return true;
          try { return new URL(url).origin === location.origin; }
          catch { return true; }
        });
      }
    }
  ];

  const selfTestSection = section('Check it yourself',
    p('Don\'t just take our word for it. Click the button below and this app will check its own privacy, right now, on your device.'),
    checkContainer,
    overallResult
  );

  const runChecks = async (btn) => {
    btn.disabled = true;
    btn.textContent = 'Checking...';
    checkContainer.innerHTML = '';
    overallResult.innerHTML = '';

    let allPassed = true;

    for (const check of checks) {
      const row = h('div', { className: 'privacy-check-row' });
      const icon = h('span', { className: 'privacy-check-icon checking' }, '...');
      const label = h('span', { className: 'privacy-check-label' }, check.label);
      const explain = h('div', { className: 'privacy-check-explain' }, check.explanation);
      row.appendChild(icon);
      const textWrap = h('div', {});
      textWrap.appendChild(label);
      textWrap.appendChild(explain);
      row.appendChild(textWrap);
      checkContainer.appendChild(row);

      // Small delay so each check appears one at a time
      await new Promise(r => setTimeout(r, 350));

      let passed;
      try {
        passed = await check.test();
      } catch {
        passed = false;
      }

      if (passed) {
        icon.textContent = '\u2713';
        icon.className = 'privacy-check-icon pass';
      } else {
        icon.textContent = '\u2717';
        icon.className = 'privacy-check-icon fail';
        allPassed = false;
      }
    }

    if (allPassed) {
      overallResult.className = 'privacy-overall-result pass';
      overallResult.textContent = 'All checks passed. This app is private. Nothing is being sent to anyone.';
    } else {
      overallResult.className = 'privacy-overall-result fail';
      overallResult.textContent = 'One or more checks did not pass. This is unusual — try reloading the page.';
    }

    btn.textContent = 'Run checks again';
    btn.disabled = false;
  };

  const testBtn = h('button', {
    className: 'btn',
    style: { marginTop: '1rem', marginBottom: '1rem' },
    onClick: function () { runChecks(this); }
  }, 'Run privacy check');
  selfTestSection.insertBefore(testBtn, checkContainer);

  page.appendChild(selfTestSection);

  // ── Section 5: Verify with your browser ─────────────────────────────────
  const verifySection = section('Verify with your browser',
    p('You can also check for yourself using tools built into your browser, or by simply turning off your internet. Pick the method that matches your device.')
  );

  const guides = [
    {
      id: 'airplane',
      label: 'Airplane Mode',
      intro: 'This is the simplest test. If the app works with no internet, it cannot be sending your data anywhere.',
      steps: [
        { heading: 'Phone or tablet', text: 'Open your Settings or swipe down from the top of your screen and turn on Airplane Mode.' },
        { heading: 'Computer', text: 'Click the WiFi icon in your menu bar or taskbar and turn WiFi off. Unplug any ethernet cable too.' },
        { heading: 'Then', text: 'Use this app normally — take the test, view your results. Everything should work exactly the same.' },
        { heading: 'When done', text: 'Turn WiFi or Airplane Mode back on.' }
      ],
      note: 'If the app works completely with no internet — no errors, no spinning, no "check your connection" messages — then it is impossible for it to be sending your data anywhere. You cannot upload something without a connection.'
    },
    {
      id: 'chrome',
      label: 'Chrome',
      intro: 'You can watch every network request Chrome makes in real time.',
      steps: [
        { heading: null, text: 'Right-click anywhere on this page and choose "Inspect" from the menu.' },
        { heading: null, text: 'A panel will open. Click the "Network" tab along the top of that panel.' },
        { heading: null, text: 'Now use the app — answer questions, view results, navigate around.' },
        { heading: null, text: 'Watch the list in the panel. After the page first loads, no new rows should appear. An empty list means nothing is being sent.' }
      ],
      note: 'Tip: Click the "Fetch/XHR" filter button for the clearest view — this shows only data requests, which should be completely empty. Keyboard shortcut: F12 (Windows) or Cmd+Option+I (Mac).'
    },
    {
      id: 'firefox',
      label: 'Firefox',
      intro: 'Firefox has the same kind of network inspector as Chrome.',
      steps: [
        { heading: null, text: 'Right-click anywhere on this page and choose "Inspect" from the bottom of the menu.' },
        { heading: null, text: 'A panel will open. Click the "Network" tab along the top.' },
        { heading: null, text: 'Use the app — take the test, view your results.' },
        { heading: null, text: 'The list should not grow after the page finishes loading. You may see "No requests" — that is exactly right.' }
      ],
      note: 'Tip: Click the "XHR" filter button inside the Network panel to show only data requests. Keyboard shortcut: F12 or Ctrl+Shift+I (Windows) / Cmd+Option+I (Mac).'
    },
    {
      id: 'safari',
      label: 'Safari',
      intro: 'Safari needs a one-time setting change before you can inspect network traffic.',
      steps: [
        { heading: 'One-time setup', text: 'Open Safari, click "Safari" in the menu bar at the top, choose "Settings", click the "Advanced" tab, and check "Show features for web developers".' },
        { heading: null, text: 'Now click "Develop" in the menu bar and choose "Show Web Inspector".' },
        { heading: null, text: 'Click the "Network" tab in the panel that opens.' },
        { heading: null, text: 'Use the app and watch the request list. It should stop growing once the page finishes loading.' }
      ],
      note: 'Keyboard shortcut (after enabling developer features): Cmd+Option+I. On iPhones and iPads there is no built-in inspector — use the Airplane Mode test instead.'
    },
    {
      id: 'edge',
      label: 'Edge',
      intro: 'Edge uses the same developer tools as Chrome.',
      steps: [
        { heading: null, text: 'Right-click anywhere on this page and choose "Inspect".' },
        { heading: null, text: 'Click the "Network" tab in the panel that opens.' },
        { heading: null, text: 'Use the app — take the test, navigate around.' },
        { heading: null, text: 'No new rows should appear after the page loads. If the list stays empty, nothing is being sent.' }
      ],
      note: 'Keyboard shortcut: F12 (Windows) or Cmd+Option+I (Mac).'
    }
  ];

  // Tabs
  const tabs = h('div', { className: 'verify-tabs' });
  const panels = h('div', {});

  guides.forEach((guide, i) => {
    const tab = h('button', {
      className: `verify-tab${i === 0 ? ' active' : ''}`,
      onClick: () => {
        tabs.querySelectorAll('.verify-tab').forEach(t => t.classList.remove('active'));
        panels.querySelectorAll('.verify-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        panel.classList.add('active');
      }
    }, guide.label);
    tabs.appendChild(tab);

    const panel = h('div', { className: `verify-panel${i === 0 ? ' active' : ''}` });
    panel.appendChild(h('p', { className: 'privacy-p', style: { marginBottom: '0.75rem' } }, guide.intro));

    guide.steps.forEach((step, si) => {
      const stepEl = h('div', { className: 'verify-step' },
        h('span', { className: 'step-num' }, String(si + 1))
      );
      const textEl = h('span', {});
      if (step.heading) {
        textEl.appendChild(h('strong', {}, step.heading + ': '));
      }
      textEl.appendChild(document.createTextNode(step.text));
      stepEl.appendChild(textEl);
      panel.appendChild(stepEl);
    });

    if (guide.note) {
      const noteClass = guide.id === 'airplane' ? 'verify-highlight' : 'verify-note';
      panel.appendChild(h('div', { className: noteClass }, guide.note));
    }

    panels.appendChild(panel);
  });

  verifySection.appendChild(tabs);
  verifySection.appendChild(panels);
  page.appendChild(verifySection);

  // ── Section 6: Delete everything ────────────────────────────────────────
  const deleteConfirm = h('div', { className: 'privacy-delete-confirm' });

  page.appendChild(section('Delete everything',
    p('Want to remove all traces of this app from your browser? The button below will erase all saved data (your results, your language choice, and any in-progress answers) and remove the saved copy of the app itself. It is like you never visited.'),
    h('button', {
      className: 'btn btn--delete',
      onClick: async () => {
        // Clear all localStorage items used by the app
        localStorage.removeItem('b5-lang');
        localStorage.removeItem('b5-progress');
        localStorage.removeItem('b5-results');

        // Unregister service worker
        if ('serviceWorker' in navigator) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          for (const reg of registrations) {
            await reg.unregister();
          }
        }

        // Clear all caches
        if ('caches' in window) {
          const cacheNames = await caches.keys();
          for (const name of cacheNames) {
            await caches.delete(name);
          }
        }

        deleteConfirm.className = 'privacy-delete-confirm visible';
        deleteConfirm.textContent = 'Done. Everything has been removed. You can close this tab now — it is like you were never here.';
      }
    }, 'Delete all my data and remove this app'),
    deleteConfirm
  ));

  return page;
}

// ---------------------------------------------------------------------------
// About page
// ---------------------------------------------------------------------------
function renderAbout() {
  const page = h('div', { className: 'privacy-page' });

  page.appendChild(h('h2', {}, 'About This Test'));

  // The test
  const testSection = h('section', { className: 'privacy-section' });
  testSection.appendChild(h('h3', {}, 'The Personality Inventory'));
  testSection.appendChild(h('p', {},
    'This application uses the ',
    h('a', { href: 'https://ipip.ori.org/', target: '_blank', rel: 'noopener' }, 'IPIP-NEO-PI-R'),
    ' — a 120-item personality inventory from the ',
    h('a', { href: 'https://ipip.ori.org/', target: '_blank', rel: 'noopener' }, 'International Personality Item Pool'),
    '. The IPIP-NEO-PI-R measures the same five broad domains (Openness, Conscientiousness, Extraversion, Agreeableness, and Neuroticism) and thirty facets as the commercial NEO PI-R, but its items are in the public domain.'
  ));
  testSection.appendChild(h('p', {},
    'For more about Big Five personality research, see the ',
    h('a', { href: 'https://www.ocf.berkeley.edu/~johnlab/measures.html', target: '_blank', rel: 'noopener' }, 'Berkeley Personality Lab'),
    '.'
  ));
  page.appendChild(testSection);

  // How it works
  const howSection = h('section', { className: 'privacy-section' });
  howSection.appendChild(h('h3', {}, 'How It Works'));
  howSection.appendChild(h('p', {}, 'The entire test runs in your browser. No servers, no accounts, no tracking. Your answers are scored locally and stored only on your device. You can delete everything from the Privacy page at any time.'));
  page.appendChild(howSection);

  // Open source
  const ossSection = h('section', { className: 'privacy-section' });
  ossSection.appendChild(h('h3', {}, 'Open Source'));
  ossSection.appendChild(h('p', {},
    'This project builds on the open-source work of ',
    h('a', { href: 'https://github.com/rubynor/bigfive-web', target: '_blank', rel: 'noopener' }, 'bigfive-web'),
    ' by B5 Holding AS / Rubynor, licensed under the ',
    h('a', { href: 'https://github.com/rubynor/bigfive-web/blob/master/LICENSE', target: '_blank', rel: 'noopener' }, 'MIT License'),
    '.'
  ));
  ossSection.appendChild(h('p', {}, 'The IPIP items and scoring keys are in the public domain and free for any use.'));
  ossSection.appendChild(h('p', { style: { marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--text-dim)' } },
    'Note: as of February 2026, the bigfive-web hosted site does collect user information. This project was created to provide an alternative that does not.'
  ));
  page.appendChild(ossSection);

  // Licenses
  const licSection = h('section', { className: 'privacy-section' });
  licSection.appendChild(h('h3', {}, 'Licenses'));

  const licList = h('ul', { style: { paddingLeft: '1.25rem', lineHeight: '1.8' } });
  licList.appendChild(h('li', {},
    h('strong', {}, 'IPIP-NEO-PI-R items'), ' — Public domain (',
    h('a', { href: 'https://ipip.ori.org/', target: '_blank', rel: 'noopener' }, 'ipip.ori.org'), ')'
  ));
  licList.appendChild(h('li', {},
    h('strong', {}, 'bigfive-web'), ' — MIT License, (C) B5 Holding AS (',
    h('a', { href: 'https://github.com/rubynor/bigfive-web/blob/master/LICENSE', target: '_blank', rel: 'noopener' }, 'view license'), ')'
  ));
  licList.appendChild(h('li', {},
    h('strong', {}, 'QR Code generator'), ' — MIT License, (C) Project Nayuki (',
    h('a', { href: 'https://www.nayuki.io/page/qr-code-generator-library', target: '_blank', rel: 'noopener' }, 'source'), ')'
  ));
  licList.appendChild(h('li', {},
    h('strong', {}, 'This application'), ' — MIT License, (C) 2026 Stuffbucket'
  ));
  licSection.appendChild(licList);
  licSection.appendChild(h('p', { style: { marginTop: '0.75rem' } },
    'Full license text: ',
    h('a', { href: 'https://github.com/stuffbucket/bigfive/blob/main/LICENSE', target: '_blank', rel: 'noopener' }, 'LICENSE')
  ));
  page.appendChild(licSection);

  page.appendChild(h('p', { style: { marginTop: '1.5rem', opacity: '0.7', fontSize: '0.85rem' } },
    'Note: clicking any of the links on this page will open an external website, which means your browser will make a network request. For more details, see the ',
    h('a', { href: '#/privacy' }, 'Privacy'),
    ' page.'
  ));

  return page;
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------
function render() {
  const route = getRoute();
  app.innerHTML = '';

  app.appendChild(renderHeader());

  switch (route) {
    case 'test': app.appendChild(renderTest()); break;
    case 'results': app.appendChild(renderResults()); break;
    case 'privacy': app.appendChild(renderPrivacy()); break;
    case 'about': app.appendChild(renderAbout()); break;
    default: app.appendChild(renderHome()); break;
  }

  app.appendChild(renderFooter());
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
render();

// ---------------------------------------------------------------------------
// Offline indicator
// ---------------------------------------------------------------------------
function updateOfflineBanner() {
  const existing = document.getElementById('offline-banner');
  if (!navigator.onLine) {
    if (existing) return;
    const banner = document.createElement('div');
    banner.id = 'offline-banner';
    banner.textContent = 'You are offline — running from saved cache';
    banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;padding:0.5rem 1rem;text-align:center;background:#2d2d4e;color:#a0a0c0;font-size:0.8rem;z-index:999;border-top:1px solid #3d3d6e';
    document.body.appendChild(banner);
  } else {
    existing?.remove();
  }
}
window.addEventListener('online', updateOfflineBanner);
window.addEventListener('offline', updateOfflineBanner);
updateOfflineBanner();

// ---------------------------------------------------------------------------
// Service Worker registration + first-install toast
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'activated' && !navigator.serviceWorker.controller) {
          const toast = document.createElement('div');
          toast.textContent = 'App saved — works offline from now on';
          toast.style.cssText = 'position:fixed;bottom:1rem;left:50%;transform:translateX(-50%);background:#2e7d32;color:#fff;padding:0.6rem 1.2rem;border-radius:6px;font-size:0.85rem;z-index:999;box-shadow:0 2px 8px rgba(0,0,0,0.4)';
          document.body.appendChild(toast);
          setTimeout(() => toast.remove(), 4000);
        }
      });
    });
  }).catch(() => {});
}
