# Updating Neat Freak on the Chrome Web Store

The extension is already published and approved. This is the **update** flow (much
shorter than a first submission — no new item, no re-verifying your account).

## 1. Upload the new build

1. Go to the [Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Click the existing **Neat Freak** item.
3. Left sidebar → **Package** → **Upload new package**.
4. Drag in **`neat-freak-v1.3.0.zip`** (in this folder).
   - The version in the zip's `manifest.json` is `1.3.0`, which is higher than
     the published build — the dashboard requires this or it rejects the upload.

## 2. Refresh the store listing assets (optional but recommended)

This release re-did all the marketing art around the real mascot. To use it:

- **Screenshots** (Store listing → Screenshots) — replace with the four 1280×800s:
  - `../deck/store-screenshot-1.png` — Hero
  - `../deck/store-screenshot-2.png` — Smart tidy ("It knows what to keep")
  - `../deck/store-screenshot-3.png` — Smart grouping
  - `../deck/store-screenshot-4.png` — Search
- **Marquee** (1400×560) — `../deck/store-marquee-1400x560.png`
- **Small promo tile** (440×280) — `../deck/store-promo-440x280.png`
- **Description** — the refreshed copy is in `listing.md` (now covers the Tidy
  panel, Review-before-closing, smart save, and the optional AI). Paste if you
  want the listing to match the new features.

If you skip this, the old listing art stays and only the code updates — that's fine.

## 3. "What's new" (optional)

Chrome doesn't require release notes, but if you keep a changelog, this release adds:

- **Floating Tidy panel** with a friendly mascot (clutter / saving / done states)
- **Review before closing** — preview the categorized list and keep any tab before it closes
- **Smarter Smart save** — protects work-in-progress, dedups URLs, groups by workstream + timing
- **First-run onboarding** with tidy-default choices
- **Gentler nudges** — clutter alert escalates at a few thresholds, then backs off
- **Swipe-to-dismiss** the panel, and a reassurance bubble during long saves ("No need to wait — I'll find you.")

## 4. Submit

1. Click **Submit for review** (top right).
2. Fix any field the dashboard flags, then confirm.
3. Updates usually clear review faster than a first submission (often hours, sometimes 1–2 days).

## Notes

- The save flow, permissions, and privacy posture are unchanged from the approved
  version, so no new permission prompts and no new privacy review should be triggered.
- `privacy-policy.md` only had its "last updated" date refreshed — if the hosted
  copy is a snapshot, re-publish it; if it points at the repo, nothing to do.
