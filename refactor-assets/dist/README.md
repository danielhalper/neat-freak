# Neat Freak — component handoff

A tab-anxiety mascot for the Neat Freak app. Single React component, pure CSS animations, no dependencies beyond React.

## Install

Drop both files into your component folder:

```
src/components/NeatFreak/
├── NeatFreak.jsx
└── NeatFreak.css
```

The CSS is imported by the JSX (`import './NeatFreak.css'`) — no extra wiring needed if your bundler handles CSS imports (Vite, Next, CRA, etc.). If it doesn't, import `NeatFreak.css` once globally.

## Usage

```jsx
import NeatFreak from './components/NeatFreak/NeatFreak';

function Toolbar() {
  return (
    <div className="chrome-top-right">
      <NeatFreak state="happy" size={220} />
    </div>
  );
}
```

## Props

| Prop  | Type   | Default   | Notes                                                                |
|-------|--------|-----------|----------------------------------------------------------------------|
| state | string | `'happy'` | `'sleeping' \| 'happy' \| 'cleaning' \| 'celebrating' \| 'nervous'`  |
| size  | number | `220`     | Width in px. Height = size × 0.78 (he peeks up over a ledge).         |
| label | string | —         | Optional caption rendered below.                                      |

## States

| State         | When                                       | Animation                                                  |
|---------------|--------------------------------------------|------------------------------------------------------------|
| `sleeping`    | 0 tabs                                     | Slow snore + 3 Zzz drift up                                |
| `happy`       | tabs ≤ budget (default mood)               | Calm bob, soft smile, looks up-left                        |
| `cleaning`    | a cleanup is actively running              | Faster bob + all 8 fingers tap like he's typing            |
| `celebrating` | just finished a cleanup                    | Big squash-bounce + curved smile-eyes + blush + sparkles   |
| `nervous`     | tabs > budget                              | Shake + eye scan + sweat drops + "!" pops                  |

## Tab-count → state recipe

```jsx
const mood =
  tabs.length === 0     ? 'sleeping'    :
  tabs.length > budget  ? 'nervous'     :
  isCleaningInProgress  ? 'cleaning'    :
  justCompletedClean    ? 'celebrating' :  // hold for ~2.5s, then return
                          'happy';
```

A reasonable pattern for `justCompletedClean`:

```jsx
const [celebrate, setCelebrate] = useState(false);

const runClean = async () => {
  setCelebrate(false);
  await actuallyCleanTabs();
  setCelebrate(true);
  setTimeout(() => setCelebrate(false), 2500);
};
```

## Anatomy / sizing

- SVG `viewBox="0 0 200 155"` (≈ 1.29 : 1, landscape).
- Anchored bottom-center. Fingertips at y ≈ 140–145, ledge line at y = 155.
- Safe margin: leave ~16 px of clearance above and 20 px to the right so the sweat drops and "!" don't clip in `nervous`.
- The character is exported as a single `<div>` containing an `<svg>` — no portals, no measurement, no JS animation. Cheap to render many of him, but you'll only ever have one on screen.

## Color tokens

The palette is exported as `NF_PALETTE`:

```jsx
import { NF_PALETTE } from './NeatFreak';
// NF_PALETTE.body, .bodyDeep, .bodyDark, .hand, .hair, .hairDark,
// .eyeWhite, .pupil, .sparkle, .sweat
```

| Token       | Hex       | Where                                              |
|-------------|-----------|----------------------------------------------------|
| `body`      | `#1f9b8f` | Body fill                                          |
| `bodyDeep`  | `#0f766e` | Darker spots on body                               |
| `bodyDark`  | `#093f3b` | Outlines, brows, mouth                             |
| `hand`      | `#3aaca0` | Fingers (lighter than body)                        |
| `hair`      | `#f4bd45` | Amber poof                                         |
| `hairDark`  | `#c69325` | Hair outline                                       |
| `eyeWhite`  | `#f7f8f6` | Eye whites                                         |
| `sparkle`   | `#f4bd45` | Sparkles, blush, "!"                               |
| `sweat`     | `#a3d9ff` | Sweat drops                                        |

## Accessibility

- All animations are pure CSS. The component honors `prefers-reduced-motion: reduce` and freezes all motion when the user requests it.
- The character is decorative — if you need it announced, wrap with appropriate `aria-label` / `role` at the call site. By default it carries no aria.

## Customising

- **Recolor the body**: override the CSS custom properties or pass through the palette. Easiest: edit `NF_PALETTE` at the top of `NeatFreak.jsx`.
- **Change animation timing**: every animation lives in `NeatFreak.css` and uses the `nf-` prefix. Find the keyframe by state name (e.g. `nf-bounce`, `nf-finger-tap`).
- **Disable specific states**: just don't pass them. The component falls back gracefully if you pass an unknown state (face/animation default to nothing — body still renders).
