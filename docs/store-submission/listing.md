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

Everything lives in your browser's local storage. No account, no sync, no servers (we don't run any). The one exception: if you switch on AI grouping, tab titles and short page summaries go to OpenAI using YOUR own API key — off by default, stored only on your device.

— OPTIONAL AI UPGRADE —

Add your own OpenAI key and Neat Freak uses gpt-5.4-mini to get sharper still:
- Smarter keep-vs-file calls (your work-in-progress stays, reference tabs get filed)
- Workstream-aware folder names ("Job Hunt: UX Roles," not "linkedin.com group")
- Natural-language search across everything you've saved

No key? The built-in engine still works great. The AI is polish, not a requirement.

— BUILT FOR PEOPLE WHO —

- Open 50 tabs before lunch
- Lose work when Chrome runs out of memory
- Want their browser to remember the shape of yesterday's work, not just the links
- Are done with OneTab's flat list

No account. No ads. No telemetry. Just tidy, find, restore. Pin Neat Freak to your toolbar and click it whenever your tabs get out of hand.
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
| Authentication information | **Yes (locally only)** | OpenAI API key, only if user provides one. Stored in chrome.storage.local on the user's device. Never transmitted anywhere except api.openai.com when the user explicitly triggers AI grouping. |
| Personal communications | **No** | |
| Location | **No** | |
| Web history | **Yes** | Tab titles and URLs are saved locally to enable the core feature. When AI grouping is enabled, titles + URLs + short page summaries are sent to OpenAI via the user's own API key. Never persisted server-side by Neat Freak. |
| User activity | **No** | No analytics, no telemetry, no event tracking. |
| Website content | **Yes (transient)** | A short text summary of each page (title + first paragraphs) is extracted at save time to improve grouping. Used immediately, not persisted beyond the saved session, never transmitted unless AI grouping is enabled. |

Required certifications:
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

Privacy policy URL: **see `privacy-policy.md` — host it publicly (GitHub Pages, your domain, etc.) and paste the URL here.**
