// Generates standalone SVG files of the Neat Freak CHARACTER (the round-bodied
// creature with arms) for use in the Chrome Web Store deck.
//
// SOURCE OF TRUTH: renderMascotInner() + nfDropMarkup() in
// src/neat-freak-panel.js. This file copies those two functions so the deck
// can render the real in-product character statically (no DOM, no CSS
// animation). If the in-product mascot art changes, re-sync the two functions
// below and re-run: `node build-character-svgs.js`.
//
// Output: mascot-character-<mood>.svg in this folder. Deck-only assets — they
// are NOT shipped in the extension zip.

const fs = require("fs");
const path = require("path");

// ---- copied verbatim from src/neat-freak-panel.js (keep in sync) ----
function nfDropMarkup(cx, cy, scale, className) {
  const w = 6 * scale;
  const h = 13 * scale;
  const d = `M ${cx} ${cy} C ${cx - w * 0.9} ${cy + h * 0.45}, ${cx - w} ${cy + h}, ${cx} ${cy + h} C ${cx + w} ${cy + h}, ${cx + w * 0.9} ${cy + h * 0.45}, ${cx} ${cy} Z`;
  return `
    <g class="${className}">
      <path d="${d}" fill="#a3d9ff" stroke="#093f3b" stroke-width="1.6" stroke-linejoin="round"/>
      <ellipse cx="${cx - w * 0.35}" cy="${cy + h * 0.65}" rx="${w * 0.22}" ry="${h * 0.18}" fill="#f7f8f6" opacity="0.75"/>
    </g>`;
}

function renderMascotInner(mood) {
  const sleeping    = mood === "sleeping";
  const cleaning    = mood === "cleaning";
  const celebrating = mood === "celebrating";
  const nervous     = mood === "nervous";

  const browPath = {
    sleeping:    [null, null],
    happy:       [null, null],
    cleaning:    ["M 50 66 Q 60 62 70 68", "M 100 68 Q 110 62 120 66"],
    nervous:     ["M 46 64 Q 57 60 68 58", "M 100 58 Q 113 60 120 64"],
    celebrating: ["M 48 62 Q 56 58 66 62", "M 102 62 Q 110 58 118 62"]
  }[mood] || [null, null];
  const [browL, browR] = browPath;

  const lookOffset = {
    sleeping:    { x: 0,  y: 0  },
    happy:       { x: -2, y: -1 },
    cleaning:    { x: -2, y: 2  },
    nervous:     { x: 0,  y: -1 },
    celebrating: { x: -1, y: 0  }
  }[mood] || { x: 0, y: 0 };

  const mouth = {
    sleeping:    { d: "M 74 118 Q 80 124 86 118 Q 80 122 74 118 Z",         fill: "#093f3b" },
    happy:       { d: "M 64 114 Q 80 126 96 114",                           fill: "none"    },
    cleaning:    { d: "M 76 117 Q 80 122 84 117 Q 80 120 76 117 Z",         fill: "#093f3b" },
    nervous:     { d: "M 68 118 Q 74 112 80 118 T 92 118",                  fill: "none"    },
    celebrating: { d: "M 58 110 Q 80 134 102 110 Q 80 124 58 110 Z",        fill: "#093f3b" }
  }[mood] || { d: "M 64 114 Q 80 126 96 114", fill: "none" };

  const eyesClosed = sleeping;
  const eyesCurved = celebrating;

  const browsMarkup = (browL || browR) ? `
    <g class="nf-brows" stroke="#093f3b" stroke-width="4.5" stroke-linecap="round" fill="none">
      ${browL ? `<path d="${browL}"/>` : ""}
      ${browR ? `<path d="${browR}"/>` : ""}
    </g>` : "";

  const eyeWhite = nervous
    ? { lrx: 13, lry: 14, rrx: 11, rry: 13 }
    : { lrx: 10, lry: 11, rrx: 8,  rry: 10 };

  const eyesMarkup = (!eyesClosed && !eyesCurved) ? `
    <g class="nf-eyes">
      <ellipse cx="60"  cy="88" rx="${eyeWhite.lrx}" ry="${eyeWhite.lry}" fill="#f7f8f6"/>
      <ellipse cx="110" cy="88" rx="${eyeWhite.rrx}"  ry="${eyeWhite.rry}" fill="#f7f8f6"/>
      <g class="nf-pupils" transform="translate(${lookOffset.x} ${lookOffset.y})">
        <circle cx="58"    cy="84"   r="4"   fill="#093f3b"/>
        <circle cx="108"   cy="84"   r="3.4" fill="#093f3b"/>
        <circle cx="56.6"  cy="82.6" r="1.3" fill="#f7f8f6"/>
        <circle cx="106.8" cy="82.8" r="1.1" fill="#f7f8f6"/>
      </g>
    </g>` : `
    <g class="nf-eyes nf-eyes-closed" stroke="#093f3b" stroke-width="4" fill="none" stroke-linecap="round">
      ${eyesCurved
        ? `<path d="M 50 88 Q 60 78 70 88"/><path d="M 100 88 Q 110 80 120 88"/>`
        : `<path d="M 50 88 Q 60 94 70 88"/><path d="M 102 88 Q 110 93 118 88"/>`}
    </g>`;

  const blushMarkup = celebrating ? `
    <g class="nf-blush" fill="#f4bd45" opacity="0.55">
      <ellipse cx="42"  cy="108" rx="5" ry="3"/>
      <ellipse cx="118" cy="108" rx="5" ry="3"/>
    </g>` : "";

  const zzzMarkup = sleeping ? `
    <g class="nf-zzz" fill="none" stroke="#093f3b" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" transform="translate(60 30)">
      <path class="nf-z nf-z--1" d="M 150 60 h 9 l -9 11 h 9"/>
      <path class="nf-z nf-z--2" d="M 164 35 h 7 l -7 8 h 7"/>
      <path class="nf-z nf-z--3" d="M 174 15 h 5 l -5 6 h 5"/>
    </g>` : "";

  const sweatMarkup = nervous ? `
    <g class="nf-sweat" transform="translate(60 30)">
      ${nfDropMarkup(20,  70, 0.8, "nf-drop nf-drop--1")}
      ${nfDropMarkup(178, 75, 0.8, "nf-drop nf-drop--2")}
    </g>
    <g class="nf-bang" transform="translate(60 30)">
      <text x="60" y="55" text-anchor="middle" font-family="ui-sans-serif, system-ui"
            font-weight="900" font-size="26" fill="#f4bd45"
            stroke="#093f3b" stroke-width="1.5" paint-order="stroke">!</text>
    </g>` : "";

  const fingerL = [
    { x: 15.5, y: 140, h: 21 },
    { x: 24.5, y: 138, h: 23 },
    { x: 33.5, y: 138, h: 23 },
    { x: 42.5, y: 139, h: 22 }
  ];
  const fingerR = [
    { x: 150.5, y: 139, h: 22 },
    { x: 159.5, y: 138, h: 23 },
    { x: 168.5, y: 138, h: 23 },
    { x: 177.5, y: 140, h: 21 }
  ];
  const fingerRectsL = fingerL.map((f, i) =>
    `<rect class="nf-finger nf-finger--left-${i}" x="${f.x}" y="${f.y}" width="9" height="${f.h}" rx="4.5" fill="#3aaca0"/>`
  ).join("");
  const fingerRectsR = fingerR.map((f, i) =>
    `<rect class="nf-finger nf-finger--right-${i}" x="${f.x}" y="${f.y}" width="9" height="${f.h}" rx="4.5" fill="#3aaca0"/>`
  ).join("");

  return `
    <g fill="none" stroke="#9ccfc3" stroke-width="2" opacity="0.75">
      <circle cx="20"  cy="92"  r="6"/>
      <circle cx="302" cy="84"  r="5"/>
      <circle cx="304" cy="156" r="4.5"/>
      <circle cx="48"  cy="172" r="4"/>
    </g>
    <g fill="#7eb8ab" opacity="0.85">
      <path d="M 38 54 Q 38.9 58.1 43 59 Q 38.9 59.9 38 64 Q 37.1 59.9 33 59 Q 37.1 58.1 38 54 Z"/>
      <path d="M 284 48 Q 284.72 51.28 288 52 Q 284.72 52.72 284 56 Q 283.28 52.72 280 52 Q 283.28 51.28 284 48 Z"/>
      <path d="M 292 124 Q 292.54 126.46 295 127 Q 292.54 127.54 292 130 Q 291.46 127.54 289 127 Q 291.46 126.46 292 124 Z"/>
      <path d="M 24 140 Q 24.72 143.28 28 144 Q 24.72 144.72 24 148 Q 23.28 144.72 20 144 Q 23.28 143.28 24 140 Z"/>
    </g>

    ${zzzMarkup}

    <ellipse cx="160" cy="184" rx="62" ry="3" fill="#093f3b" opacity="0.1"/>

    <g class="nf-tilt" transform="translate(60 30)">
      <g class="nf-body-g">
        <path d="M 16 155 C 12 105, 22 62, 56 50 C 88 38, 130 42, 162 56 C 184 72, 186 120, 182 155 Z" fill="#1f9b8f"/>
        <g fill="#0f766e" opacity="0.55">
          <ellipse cx="58"  cy="122" rx="6"   ry="4"/>
          <ellipse cx="36"  cy="100" rx="4.5" ry="3.2"/>
          <ellipse cx="148" cy="130" rx="7"   ry="4.5"/>
          <ellipse cx="170" cy="108" rx="4.5" ry="3"/>
          <ellipse cx="96"  cy="140" rx="5"   ry="3.2"/>
          <ellipse cx="128" cy="96"  rx="3.5" ry="2.6"/>
        </g>
        <path d="M 56 64 Q 70 46 92 42" stroke="#ffffff" stroke-width="6" stroke-linecap="round" opacity="0.13" fill="none"/>
        <g class="nf-face">
          ${browsMarkup}
          ${eyesMarkup}
          <path class="nf-mouth" d="${mouth.d}" fill="${mouth.fill}" stroke="#093f3b" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
          ${blushMarkup}
        </g>
      </g>
    </g>

    <g class="nf-hands" transform="translate(60 30)">
      <g class="nf-hand nf-hand--left">${fingerRectsL}</g>
      <g class="nf-hand nf-hand--right">${fingerRectsR}</g>
    </g>

    ${sweatMarkup}
  `;
}
// ---- end copied section ----

function standaloneSvg(mood) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200" role="img" aria-label="Neat Freak — ${mood}">
${renderMascotInner(mood)}
</svg>
`;
}

const MOODS = ["happy", "celebrating", "nervous", "sleeping"];
for (const mood of MOODS) {
  const out = path.join(__dirname, `mascot-character-${mood}.svg`);
  fs.writeFileSync(out, standaloneSvg(mood));
  console.log("Wrote", out);
}
