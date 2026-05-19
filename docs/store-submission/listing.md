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
Neat Freak is a tab-saver with a brain.

Click once, and every open tab in every window collapses into a memory-light session — automatically grouped into folders by what you're actually working on. Not by domain. Not by date. By workstream.

Chrome reclaims the RAM. You keep the context.

— THREE JOBS. ONE CLICK. —

SAVE
Snapshot every open tab into a memory-light session. Tabs close, Chrome frees up memory. Pinned tabs stay open by default.

GROUP
Tabs auto-organize into folders by topic. The grouping engine reads titles, domains, and a short page summary to figure out which tabs belong together — your active workstreams, not just "all your Google Docs."

FIND
Search every saved tab by keyword, or ask in plain English ("ux applicants I looked up?") and Neat Freak finds them. Restore one tab, a whole folder, or an entire session.

— WHY IT'S DIFFERENT —

OneTab and similar extensions give you a flat list of URLs. Useful for memory. Useless for focus.

Neat Freak organizes those URLs into folders by what you were actually doing — so when you come back to a session, you see "Hiring & Candidates" and "Q4 Planning" and "That Plumber Search From Tuesday," not 87 unsorted links.

— PRIVACY —

Everything is stored in your browser's local extension storage. Nothing is sent to any server.

The exception: if you turn on AI-smart group naming in settings, tab titles and short page summaries are sent to OpenAI using YOUR own API key. This is optional, off by default, and the key is stored only on your device.

— OPTIONAL POWER-USER UPGRADE —

Drop your own OpenAI API key in settings and Neat Freak uses gpt-5-mini to:
- Pick workstream-aware folder names ("Job Hunt: UX Roles" instead of "linkedin.com group")
- Power natural-language search across every saved tab

Without a key, local grouping still works great. The AI is polish, not a requirement.

— PERFECT FOR —

People who:
- Open 50+ tabs before lunch
- Lose work-in-progress when Chrome eats their RAM
- Want their browser to remember the SHAPE of yesterday's work, not just the URLs
- Hate OneTab's flat list

— LIGHTWEIGHT —

No account. No sync. No ads. No telemetry. No data leaves your browser unless you explicitly turn on AI grouping with your own API key.

Just save, group, find. Pin Neat Freak to your toolbar and click it whenever your tabs get out of hand.
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

## Homepage URL (optional but recommended)

A small landing page or GitHub README. Suggestions:
- A GitHub repo (`https://github.com/yourname/neat-freak`)
- A simple landing page on Vercel/Netlify (one HTML file is fine)

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
