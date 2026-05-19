# How to submit Neat Freak to the Chrome Web Store

Everything you need is in this folder. The actual submission has to happen from your developer account — there's no API for first-time publishing. Expect 30–60 minutes the first time, mostly form-filling.

## What's in this folder

| File | Purpose |
|------|---------|
| `neat-freak-v1.0.0.zip` | The packaged extension. Upload this. |
| `listing.md` | Name, summary, full description, category, and search keywords — copy/paste into the listing form. |
| `privacy-policy.md` | The privacy policy. You must host this somewhere publicly accessible (GitHub Pages, your own site, a Notion public page works in a pinch). The URL goes in the store form. |
| `permissions-justifications.md` | One paragraph per permission the reviewer will ask about. |
| `../deck/store-screenshot-1.png` | Hero screenshot (1280×800). |
| `../deck/store-screenshot-2.png` | "How it works" screenshot (1280×800). |
| `../deck/store-screenshot-3.png` | Search demo screenshot (1280×800). |
| `../deck/store-promo-440x280.png` | Small promo tile (440×280). |

## Before you submit

### 1. Get a developer account (one time, $5)

1. Go to https://chrome.google.com/webstore/devconsole
2. Sign in with the Google account you want to publish under
3. Pay the one-time $5 developer registration fee
4. Verify your email if prompted

### 2. Host the privacy policy

The store requires a publicly-reachable URL.

Easiest options:
- **GitHub Pages**: Push the contents of `privacy-policy.md` to a public repo, enable Pages, get a URL like `https://yourname.github.io/neat-freak-privacy/`. 5 minutes.
- **Notion**: Paste the policy into a Notion page, share it with "anyone with the link", grab the public URL. 2 minutes.
- **Your own domain**: If you have one, drop the file at e.g. `https://yourdomain.com/neat-freak-privacy`.

Before pasting, update these placeholders in `privacy-policy.md`:
- `[your support email here]` → your real email
- `[your repo URL here, or remove this line]` → repo URL or delete the line

### 3. Pick a support email

The store needs a real email address for user contact. A Gmail alias works. Update both:
- `privacy-policy.md`
- `listing.md` (Support email section)

## The submission flow

### Step 1 — Upload the ZIP

1. In the developer console, click **"New item"**.
2. Drag in `neat-freak-v1.0.0.zip`.
3. Wait for the upload + parse to finish (~30 seconds).

### Step 2 — Fill the "Store listing" tab

Paste from `listing.md`:

| Field | Source |
|-------|--------|
| Title | `listing.md` → Name |
| Summary | `listing.md` → Summary |
| Description | `listing.md` → Detailed description |
| Category | Productivity |
| Language | English (United States) |
| Store icon | The 128×128 icon from `assets/icon-128.png` (auto-detected from the ZIP, but you can re-upload if needed) |
| Screenshots | Upload all three `store-screenshot-*.png` from `../deck/` — minimum 1, max 5 |
| Small promo tile | `../deck/store-promo-440x280.png` |
| Marquee tile (optional, 1400×560) | Skip for now |

### Step 3 — Fill the "Privacy practices" tab

This is the part most submissions get hung up on. The dashboard walks you through a permission-by-permission justification form.

- For each permission listed in the dashboard, paste the matching paragraph from `permissions-justifications.md`.
- Answer "Does your extension collect or use any of the following user data?" using the table in `listing.md` → Privacy practices declaration.
- Check the three required certifications at the bottom (no selling user data, etc.) — they're true.
- **Privacy policy URL**: paste the public URL you hosted in "Before you submit" step 2.

### Step 4 — Fill the "Distribution" tab

- **Visibility**: Public (or Unlisted if you want to soft-launch with people who have the link)
- **Geographic distribution**: All regions, unless you have a reason to restrict
- **Pricing**: Free

### Step 5 — Submit for review

1. Click **"Submit for review"** in the top right.
2. The dashboard will list any blockers (missing field, oversized image, etc.). Fix and resubmit.
3. Confirm.

Review typically takes **1–3 business days** for new extensions. Sometimes hours, occasionally 1–2 weeks if a reviewer flags the broad host permissions (see fallback plan in `permissions-justifications.md`).

## What to expect from review

Likely questions / pushback from reviewers, with prepared answers:

**"Why do you need access to all URLs?"**
> Paste the host-permissions paragraph from `permissions-justifications.md`. Emphasize that scripting runs only at save time, only on tabs the user explicitly chose to save.

**"Your extension makes API calls to api.openai.com"**
> Yes — only when the user enables AI grouping in settings AND provides their own OpenAI API key. The key is stored locally, never proxied through any server we operate. Reference the privacy policy section on this.

**"Your description mentions an AI feature but the extension works without one"**
> Confirm: local graph-based grouping is the default. The AI feature is opt-in, requires the user's own key, and the extension is fully functional without it.

## After approval

- The extension goes live at `https://chromewebstore.google.com/detail/<your-id>`.
- The `<your-id>` is auto-generated; you can't customize it.
- Updates: bump `version` in `manifest.json`, re-zip (overwriting the source folder), and upload as a new version in the same dashboard item. Updates usually clear review faster (hours).

## Things I deliberately did NOT do

- **Did not register a developer account for you** — you have to do that yourself, since billing is tied to your Google account.
- **Did not host the privacy policy** — needs a URL you control.
- **Did not include the `docs/` folder in the ZIP** — store packages should only contain runtime files. Source comments, deck assets, etc. are fine in the repo but should not ship to users.
- **Did not narrow the host permissions** — flagged as a potential review point in `permissions-justifications.md` with a fallback plan if you get pushback.
- **Did not create a landing page or marketing site** — optional, but recommended for the "Homepage URL" field. A one-page HTML on Vercel takes 10 minutes.
