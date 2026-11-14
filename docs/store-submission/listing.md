# Chrome Web Store — Listing Copy

Copy/paste directly into the store dashboard fields.

---

## Name (max 75 characters)

```
Neat Freak — Tidy Tabs, Find Your Work
```

(38 chars)

---

## Summary (single line, max 132 characters)

```
Save every open tab into memory-light folders, grouped by what you're working on. Restore in one click.
```

(102 chars)

---

## Category

**Productivity**

---

## Language

**English (United States)**

---

## Detailed description (max 16,000 characters)

```
Neat Freak is a tab-saver with a brain (and a face).

Be honest — half your open tabs are done. The article you skimmed, the doc you stopped reading, last Tuesday's plumber search. They're not work anymore. They're weight: eating your RAM and burying the three tabs you actually need.

Click "Tidy tabs." Neat Freak intelligently stashes the ones you're finished with — saved, sorted into folders, and one click from coming back — while leaving your live work open. Chrome gets its memory back. You keep your focus. Clean window in about two seconds.

— IT KNOWS WHAT YOU'RE DONE WITH —

This is the part other tab savers miss. Neat Freak doesn't dump everything into a list — it reads each tab and decides. The doc you're writing in, the half-finished checkout, the tab you're on right now: left open. The skimmed articles, dead-end searches, and reference links you won't open again: filed away. Saved, never deleted, always one click back.

— ORGANIZED BY WHAT YOU WERE DOING —

Not by domain. Not by date. By workstream. Neat Freak reads titles, domains, page content, and even which tabs you opened together to sort them into folders that actually make sense — "Hiring & Candidates," "Q4 Planning," "That Plumber Search From Tuesday" — instead of 80 unsorted links.

— YOU APPROVE BEFORE ANYTHING CLOSES —

By default, Neat Freak shows you the list first. Glance it over, click any tab to keep it open, then confirm. Nothing disappears without your okay — and the tab you're actively using is never touched. (Want pure one-click speed instead? Turn the review step off.)

— FIND ANYTHING LATER —

Search every saved tab by keyword — or just ask in plain English ("ux applicants I looked up?") and Neat Freak surfaces them by intent, even when those words aren't in the title. Restore one tab, a whole folder, or an entire session.

— A NUDGE, NEVER A NAG —

Pile up past your limit and Neat Freak quietly offers to tidy from a little corner panel — and the mascot reflects the mood: sleepy when it's calm, frazzled when tabs stack up, pleased after a tidy. Ignore it, swipe it away, or dismiss it. It will not hound you.

— WHY IT'S DIFFERENT —

OneTab and the rest hand you a flat wall of URLs. Great for memory, useless for focus. Neat Freak hands you back an organized workspace — so reopening yesterday means seeing what you were doing, not decoding 87 links.

— YOUR DATA STAYS WITH YOU —

Your saved tabs live in your browser's local storage — no account, no sync, no tracking. To group and search intelligently, the AI features (on by default) send tab titles, URLs, and short page summaries to a confidential AI backend that runs them inside a hardware secure enclave — your data can't be read by us or the AI provider, isn't stored, and isn't used to train models. No API key needed. Prefer fully local? Turn AI off in Settings.

— PRIVATE AI, BUILT IN —

No setup, no API key. AI runs on a confidential model inside a secure enclave (so your tabs stay private) and gives you:
- Smarter keep-vs-file calls (your work-in-progress stays, reference tabs get filed)
- Workstream-aware folder names ("Job Hunt: UX Roles," not "linkedin.com group")
- Natural-language search across everything you've saved

Want it fully local? Switch AI off in Settings — the built-in engine still works great.

— BUILT FOR PEOPLE WHO —

- Open 50 tabs before lunch
- Lose work when Chrome runs out of memory
- Want their browser to remember the shape of yesterday's work, not just the links
- Are done with OneTab's flat list

No account. No ads. No automatic telemetry uploads. Local troubleshooting logs can be disabled, cleared or exported in Settings. Pin Neat Freak to your toolbar and click it whenever your tabs get out of hand.
```

---

## Search keywords / tags

(Used in Web Store search ranking and admin metadata)

```
tab manager, tabs, productivity, focus, memory saver, save tabs, restore tabs, tab organizer, tab groups, workspace
```

---

## Single-purpose description (required field — what does the extension do?)

```
Neat Freak saves all open Chrome tabs into a memory-light, searchable archive — automatically grouped into folders by topic — and restores them in one click.
```

---

## Support email

```
danielhalper4@gmail.com
```

---

## Homepage URL

```
https://neat-freak.netlify.app
```

Paste into the dashboard's **Homepage URL** field (no verification needed).
Do NOT use the "Official URL" field — that requires Google Search Console
domain verification and is meant for owned custom domains; skip it.

(Source for this page lives in `docs/landing/`, deployed to Netlify.)

---

## Privacy policy URL (required)

```
https://neat-freak.netlify.app/privacy.html
```

Served by the same Netlify deploy — no separate hosting needed.

---

## Privacy practices declaration (required)

When the dashboard asks "Does your extension collect or use any of the following user data?", the honest answers are:

| Data type | Collect? | Notes |
|-----------|----------|-------|
| Personally identifiable information | **No** | |
| Health information | **No** | |
| Financial and payment information | **No** | |
| Authentication information | **No** | The extension no longer uses any API key. |
| Personal communications | **No** | Page summaries are pulled from whatever page the user saves and could incidentally include such content — flagged for review (see permissions-justifications.md). |
| Location | **No** | |
| Web history | **Yes** | Tab titles and URLs are saved locally for the core feature. When AI is on (default), titles + URLs + short page summaries are sent to Neat Freak's confidential AI backend (processed in a secure enclave, not retained). |
| User activity | **Yes (local only)** | Bounded troubleshooting events include suggestion counts, review/Keep actions, close/restore counts, timings and error categories. No page content or URLs in this log. Stored locally for up to seven days/500 events; never uploaded automatically. Users can disable, clear or manually export it. |
| Website content | **Yes** | Optional summaries are extracted from candidate pages while tidying or preparing suggestions. Background preparation starts off and requires enabling. With AI on, candidate titles, URLs and optional summaries can be sent before a Save click, including for tabs ultimately kept open. Saved summaries also remain locally in saved sessions. |

Required certifications:
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

Privacy policy URL: **see `privacy-policy.md` — host it publicly (GitHub Pages, your domain, etc.) and paste the URL here.**
