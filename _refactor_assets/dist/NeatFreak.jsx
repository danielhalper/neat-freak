import React from 'react';
import './NeatFreak.css';

/**
 * Neat Freak — your tab-anxiety mascot.
 *
 * A nervous little monster who lives in the top-right of your chrome.
 * Drives his mood from your tab-budget logic.
 *
 *   <NeatFreak state="happy" size={220} />
 *
 * Props:
 *   state  'sleeping' | 'happy' | 'cleaning' | 'celebrating' | 'nervous'
 *   size   number — width in px (renders ~0.78 * size tall). Default 280.
 *   label  string — optional caption rendered below the mascot.
 *
 * Sensible tab-count → state recipe:
 *
 *   const mood =
 *     tabs.length === 0      ? 'sleeping'    :
 *     tabs.length > budget   ? 'nervous'     :
 *     isCleaningInProgress   ? 'cleaning'    :
 *     justCompletedClean     ? 'celebrating' :
 *                              'happy';
 */

export const NF_PALETTE = {
  body: '#1f9b8f',
  bodyDeep: '#0f766e',
  bodyDark: '#093f3b',
  hand: '#3aaca0',
  hair: '#f4bd45',
  hairDark: '#c69325',
  eyeWhite: '#f7f8f6',
  pupil: '#093f3b',
  sparkle: '#f4bd45',
  sweat: '#a3d9ff',
};

const NF_BODY =
  'M 16 155 C 12 105, 22 62, 56 50 C 88 38, 130 42, 162 56 C 184 72, 186 120, 182 155 Z';

// ---- Hands ----
function NFHand({ x, side }) {
  const fingerW = 9;
  const baseY = 155;
  const heights = side === 'left' ? [15, 17, 17, 16] : [16, 17, 17, 15];
  return (
    <g className={`nf-hand nf-hand--${side}`}>
      {heights.map((h, i) => {
        const cx = x + i * fingerW;
        const top = baseY - h;
        return (
          <rect
            key={i}
            className={`nf-finger nf-finger--${side}-${i}`}
            x={cx - fingerW / 2}
            y={top}
            width={fingerW}
            height={h + 6}
            rx={fingerW / 2}
            fill={NF_PALETTE.hand}
          />
        );
      })}
    </g>
  );
}

// ---- Props (sweat / sparkles / Zzz) ----
function NFDrop({ cx, cy, scale = 1, className }) {
  const w = 6 * scale;
  const h = 13 * scale;
  const d = `M ${cx} ${cy} C ${cx - w * 0.9} ${cy + h * 0.45}, ${cx - w} ${cy + h}, ${cx} ${cy + h} C ${cx + w} ${cy + h}, ${cx + w * 0.9} ${cy + h * 0.45}, ${cx} ${cy} Z`;
  return (
    <g className={className}>
      <path d={d} fill={NF_PALETTE.sweat} stroke={NF_PALETTE.bodyDark} strokeWidth="1.6" strokeLinejoin="round" />
      <ellipse cx={cx - w * 0.35} cy={cy + h * 0.65} rx={w * 0.22} ry={h * 0.18} fill={NF_PALETTE.eyeWhite} opacity="0.75" />
    </g>
  );
}

function NFSweat() {
  return (
    <g className="nf-sweat">
      <NFDrop cx={20}  cy={70} scale={0.8} className="nf-drop nf-drop--1" />
      <NFDrop cx={178} cy={75} scale={0.8} className="nf-drop nf-drop--2" />
    </g>
  );
}

function NFSpots() {
  return (
    <g className="nf-spots" fill={NF_PALETTE.bodyDeep} opacity="0.55">
      <ellipse cx="58"  cy="122" rx="6"   ry="4" />
      <ellipse cx="36"  cy="100" rx="4.5" ry="3.2" />
      <ellipse cx="148" cy="130" rx="7"   ry="4.5" />
      <ellipse cx="170" cy="108" rx="4.5" ry="3" />
      <ellipse cx="96"  cy="140" rx="5"   ry="3.2" />
      <ellipse cx="128" cy="96"  rx="3.5" ry="2.6" />
    </g>
  );
}

function NFHair() {
  return (
    <g className="nf-hair" stroke={NF_PALETTE.hairDark} strokeWidth="1.6" strokeLinejoin="round">
      <path d="M 96 44 C 92 26, 100 18, 106 26 C 110 32, 106 42, 100 46 Z" fill={NF_PALETTE.hair} />
      <path d="M 86 46 C 76 32, 78 22, 88 24 C 96 28, 96 40, 92 50 Z" fill={NF_PALETTE.hair} />
      <path d="M 108 46 C 116 36, 124 32, 122 42 C 120 50, 112 52, 108 50 Z" fill={NF_PALETTE.hair} />
    </g>
  );
}

function NFSparkles() {
  const star = (cx, cy, r) =>
    `M ${cx} ${cy - r} Q ${cx + r * 0.18} ${cy - r * 0.18} ${cx + r} ${cy} Q ${cx + r * 0.18} ${cy + r * 0.18} ${cx} ${cy + r} Q ${cx - r * 0.18} ${cy + r * 0.18} ${cx - r} ${cy} Q ${cx - r * 0.18} ${cy - r * 0.18} ${cx} ${cy - r} Z`;
  return (
    <g className="nf-sparkles" fill={NF_PALETTE.sparkle}>
      <path className="nf-spark nf-spark--1" d={star(42, 48, 7)} />
      <path className="nf-spark nf-spark--2" d={star(162, 42, 5)} />
      <path className="nf-spark nf-spark--3" d={star(158, 100, 4)} />
      <path className="nf-spark nf-spark--4" d={star(36, 100, 5)} />
    </g>
  );
}

function NFZzz() {
  return (
    <g className="nf-zzz" fill="none" stroke={NF_PALETTE.bodyDark} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <path className="nf-z nf-z--1" d="M 150 60 h 9 l -9 11 h 9" />
      <path className="nf-z nf-z--2" d="M 164 35 h 7 l -7 8 h 7" />
      <path className="nf-z nf-z--3" d="M 174 15 h 5 l -5 6 h 5" />
    </g>
  );
}

// ---- Face ----
function NFFace({ state }) {
  const browL = {
    sleeping:    null,
    happy:       null,
    cleaning:    'M 50 66 Q 60 62 70 68',
    nervous:     'M 46 60 Q 56 50 68 62',
    celebrating: 'M 48 62 Q 56 58 66 62',
  }[state];
  const browR = {
    sleeping:    null,
    happy:       null,
    cleaning:    'M 100 68 Q 110 62 120 66',
    nervous:     'M 100 62 Q 110 50 120 60',
    celebrating: 'M 102 62 Q 110 58 118 62',
  }[state];

  const lookOffset = {
    sleeping:    { x: 0,  y: 0 },
    happy:       { x: -2, y: -1 },
    cleaning:    { x: -2, y: 2 },
    nervous:     { x: -2, y: 2 },
    celebrating: { x: -1, y: 0 },
  }[state];

  const mouth = {
    sleeping:    { d: 'M 74 118 Q 80 124 86 118 Q 80 122 74 118 Z', fill: NF_PALETTE.bodyDark },
    happy:       { d: 'M 64 114 Q 80 126 96 114', fill: 'none' },
    cleaning:    { d: 'M 76 117 Q 80 122 84 117 Q 80 120 76 117 Z', fill: NF_PALETTE.bodyDark },
    nervous:     { d: 'M 68 118 Q 74 112 80 118 T 92 118', fill: 'none' },
    celebrating: { d: 'M 58 110 Q 80 134 102 110 Q 80 124 58 110 Z', fill: NF_PALETTE.bodyDark },
  }[state];

  const eyesClosed = state === 'sleeping';
  const eyesCurved = state === 'celebrating';

  return (
    <g className="nf-face">
      {(browL || browR) && (
        <g className="nf-brows" stroke={NF_PALETTE.bodyDark} strokeWidth="4.5"
           strokeLinecap="round" fill="none">
          {browL && <path d={browL} />}
          {browR && <path d={browR} />}
        </g>
      )}

      {!eyesClosed && !eyesCurved && (
        <g className="nf-eyes">
          <ellipse cx="60" cy="88" rx="10" ry="11" fill={NF_PALETTE.eyeWhite} />
          <ellipse cx="110" cy="88" rx="8" ry="10" fill={NF_PALETTE.eyeWhite} />
          <g className="nf-pupils" transform={`translate(${lookOffset.x} ${lookOffset.y})`}>
            <circle cx="58" cy="84" r="4" fill={NF_PALETTE.pupil} />
            <circle cx="108" cy="84" r="3.4" fill={NF_PALETTE.pupil} />
            <circle cx="56.6" cy="82.6" r="1.3" fill={NF_PALETTE.eyeWhite} />
            <circle cx="106.8" cy="82.8" r="1.1" fill={NF_PALETTE.eyeWhite} />
          </g>
        </g>
      )}

      {(eyesClosed || eyesCurved) && (
        <g className="nf-eyes-closed" stroke={NF_PALETTE.bodyDark} strokeWidth="4"
           fill="none" strokeLinecap="round">
          {eyesCurved ? (
            <>
              <path d="M 50 88 Q 60 78 70 88" />
              <path d="M 100 88 Q 110 80 120 88" />
            </>
          ) : (
            <>
              <path d="M 50 88 Q 60 94 70 88" />
              <path d="M 102 88 Q 110 93 118 88" />
            </>
          )}
        </g>
      )}

      <path
        className="nf-mouth"
        d={mouth.d}
        fill={mouth.fill}
        stroke={NF_PALETTE.bodyDark}
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {state === 'celebrating' && (
        <g className="nf-blush" fill={NF_PALETTE.sparkle} opacity="0.55">
          <ellipse cx="42" cy="108" rx="5" ry="3" />
          <ellipse cx="118" cy="108" rx="5" ry="3" />
        </g>
      )}
    </g>
  );
}

// ---- Main character ----
export default function NeatFreak({ state = 'happy', size = 220, label }) {
  return (
    <div
      className={`nf-wrap nf-state-${state}`}
      style={{ width: size, height: size * 0.78 }}
    >
      <svg
        className="nf"
        viewBox="0 0 200 155"
        preserveAspectRatio="xMidYMax meet"
        width="100%"
        height="100%"
      >
        {state === 'celebrating' && <NFSparkles />}
        {state === 'sleeping' && <NFZzz />}

        <ellipse cx="100" cy="154" rx="62" ry="3" fill={NF_PALETTE.bodyDark} opacity="0.1" />

        <g className="nf-tilt">
          <g className="nf-body-g">
            <NFHair />
            <path className="nf-body" d={NF_BODY} fill={NF_PALETTE.body} />
            <NFSpots />
            <path
              d="M 56 64 Q 70 46 92 42"
              stroke="#ffffff"
              strokeWidth="6"
              strokeLinecap="round"
              opacity="0.13"
              fill="none"
            />
            <NFFace state={state} />
          </g>
        </g>

        <g className="nf-hands">
          <NFHand x={20}  side="left" />
          <NFHand x={155} side="right" />
        </g>

        {state === 'nervous' && <NFSweat />}

        {state === 'nervous' && (
          <g className="nf-bang">
            <text x="60" y="22" textAnchor="middle"
              fontFamily="ui-sans-serif, system-ui"
              fontWeight="900" fontSize="26" fill={NF_PALETTE.sparkle}
              stroke={NF_PALETTE.bodyDark} strokeWidth="1.5"
              paintOrder="stroke">!</text>
          </g>
        )}
      </svg>
      {label && <div className="nf-label">{label}</div>}
    </div>
  );
}
