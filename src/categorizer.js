import { getDomain, slugify, truncateText } from "./utils.js";

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const ASSOCIATION_THRESHOLD = 0.74;
const LLM_MODEL = "gpt-5.4-mini";

const STOP_WORDS = new Set([
  "about", "access", "account", "admin", "after", "all", "and", "are", "best", "blocked", "calendar",
  "chrome", "console", "dashboard", "doc", "docs", "document", "edit", "error", "file", "for", "from",
  "google", "home", "inbox", "login", "mail", "new", "not", "notes", "page", "portal", "search",
  "settings", "sheet", "sheets", "slides", "step", "the", "this", "with", "workspace", "updated"
]);

const GENERIC_DOMAINS = new Set([
  "airtable.com",
  "calendar.google.com",
  "claude.ai",
  "docs.google.com",
  "drive.google.com",
  "gmail.com",
  "google.com",
  "instagram.com",
  "linkedin.com",
  "mail.google.com",
  "notion.so",
  "otter.ai",
  "sheets.google.com",
  "slides.google.com"
]);

const PRODUCT_SUFFIX_PATTERNS = [
  /\s+-\s+Google (Docs|Sheets|Slides|Drive|Search)$/i,
  /\s+-\s+Gmail$/i,
  /\s+-\s+Airtable$/i,
  /\s+-\s+Claude$/i,
  /\s+-\s+Confluence$/i,
  /\s+-\s+Google Cloud console$/i,
  /\s+-\s+Chrome Web Store$/i
];

const ENTITY_ALIASES = [
  { label: "Step Up", broad: true, project: true, patterns: [/\bstep\s*up(?:\s+tutoring)?\b/i, /\bstepuptutoring\b/i] },
  { label: "Mastery", patterns: [/\bmastery\b/i, /\bstudent mastery\b/i] },
  { label: "Session Experience", patterns: [/\bsession experience\b/i] },
  { label: "AI Tutor Feedback", patterns: [/\bai tutor feedback\b/i] },
  { label: "Learning Portal", patterns: [/\blearning portal\b/i] },
  { label: "BTS", patterns: [/\bbts\b/i, /\bbeyond the school\b/i] },
  { label: "Jimmy AI", project: true, patterns: [/\bjimmy\s*ai\b/i, /\bjimmyai\b/i] },
  { label: "Quick Response Plumbing", project: true, patterns: [/\bquick response plumbing\b/i] },
  { label: "Otto", patterns: [/\botto\b/i] },
  { label: "Claude", patterns: [/\bclaude\b/i, /\banthropic\b/i] },
  { label: "Google AI Studio", patterns: [/\bgoogle ai studio\b/i, /\bai studio\b/i] },
  { label: "Google Cloud", patterns: [/\bgoogle cloud\b/i, /\bgcp\b/i] },
  { label: "Cloudflare", patterns: [/\bcloudflare\b/i] },
  { label: "Supabase", patterns: [/\bsupabase\b/i] },
  { label: "Sentry", patterns: [/\bsentry\b/i] },
  { label: "Railway", patterns: [/\brailway\b/i] },
  { label: "GitHub", patterns: [/\bgithub\b/i] },
  { label: "Airtable", broad: true, patterns: [/\bairtable\b/i] },
  { label: "Otter", broad: true, patterns: [/\botter\b/i] },
  { label: "Gmail", broad: true, patterns: [/\bgmail\b/i, /\bmail\.google\b/i] }
];

const INTENT_RULES = [
  {
    label: "Mastery & Session Experience",
    terms: ["mastery", "session experience", "student mastery", "analysis pipeline", "open ended", "card source", "action item", "ai tutor feedback", "feedback", "bts"]
  },
  {
    label: "Tutor Ops & Learning Portal",
    terms: ["tutor", "tutors", "tutor content", "content generation", "learning portal", "reminder", "reminders", "session tracking", "calendar", "ops", "airtable", "onboarding"]
  },
  {
    label: "Hiring & Candidates",
    terms: ["resume", "linkedin", "applicant", "application", "candidate", "product eng", "portfolio", "role"]
  },
  {
    label: "Infrastructure & Billing",
    terms: ["api key", "apis services", "billing", "cloudflare", "dns", "domain setup", "google cloud", "iam", "railway", "sentry", "supabase", "security"]
  },
  {
    label: "Local Services Research",
    terms: ["plumbing", "plumber", "hvac", "carpenter", "carpenters", "yelp", "marketing", "santa monica", "phcc"]
  },
  {
    label: "AI Tools & LLM Research",
    terms: ["ai studio", "anthropic", "claude", "codex", "gemini", "llm", "openai", "skill", "sycophancy"]
  },
  {
    label: "Email & Account Admin",
    terms: ["email", "gmail", "inbox", "verify", "signup", "spam", "account", "admin console"]
  },
  {
    label: "Personal Research",
    terms: ["instagram", "music", "movie", "wikipedia", "polymarket", "steps a day", "reviews"]
  }
];

const STRONG_INTENT_TERMS = new Set([
  "ai studio",
  "ai tutor feedback",
  "airtable",
  "anthropic",
  "api key",
  "applicant",
  "billing",
  "carpenter",
  "claude",
  "cloudflare",
  "content generation",
  "dns",
  "linkedin",
  "mastery",
  "plumber",
  "plumbing",
  "railway",
  "reminder",
  "resume",
  "sentry",
  "session experience",
  "supabase"
]);

export async function categorizeTabs(tabs, settings) {
  const associationGraph = buildAssociationGraph(tabs);

  if (settings.llmEnabled && settings.apiKey) {
    try {
      return await categorizeWithOpenAI(tabs, settings, associationGraph);
    } catch (error) {
      const fallback = graphCategorize(tabs, associationGraph);
      return {
        ...fallback,
        meta: {
          ...fallback.meta,
          error: normalizeLlmError(error),
          method: "association-graph-after-llm-error"
        }
      };
    }
  }

  const fallback = graphCategorize(tabs, associationGraph);
  return {
    ...fallback,
    meta: {
      ...fallback.meta,
      error: settings.llmEnabled ? "Add an OpenAI API key in settings to enable LLM grouping." : "",
      method: "association-graph"
    }
  };
}

export async function testLlm(settings) {
  const sampleTabs = [
    {
      id: "sample-1",
      title: "Mastery and Session Experience - Google Docs",
      url: "https://docs.google.com/document/d/example",
      domain: "docs.google.com",
      pageSummary: "Planning notes for Step Up Tutoring mastery tracking and session experience."
    },
    {
      id: "sample-2",
      title: "SESSION-54 [DECISION] Decide dynamic card source of truth and action item data model",
      url: "https://linear.app/stepuptutoring/issue/SESSION-54",
      domain: "linear.app",
      pageSummary: "Decision ticket for Session Experience action item data model."
    },
    {
      id: "sample-3",
      title: "Billing - Jimmy AI - Google Cloud console",
      url: "https://console.cloud.google.com/billing",
      domain: "console.cloud.google.com",
      pageSummary: "Google Cloud billing settings for the Jimmy AI project."
    }
  ];
  return categorizeWithOpenAI(sampleTabs, settings, buildAssociationGraph(sampleTabs));
}

async function categorizeWithOpenAI(tabs, settings, associationGraph) {
  const snippetBudget = chooseSnippetBudget(tabs.length, Number(settings.maxSnippetChars || 720));
  const payloadTabs = tabs.map((tab) => ({
    id: tab.id,
    title: truncateText(tab.title, 180),
    url: truncateText(tab.url, 220),
    domain: tab.domain || getDomain(tab.url),
    pageSummary: truncateText(tab.pageSummary, snippetBudget)
  }));

  const provisionalClusters = associationGraph.clusters.map((cluster) => ({
    id: cluster.id,
    provisionalName: cluster.provisionalName,
    tabIds: cluster.tabIds,
    topTerms: cluster.topTerms,
    topEntities: cluster.topEntities,
    topDomains: cluster.topDomains,
    evidenceTitles: cluster.evidenceTitles,
    relatedClusterIds: cluster.relatedClusterIds
  }));

  const prompt = [
    "You are labeling dynamic workstream clusters for a browser tab memory saver.",
    "The extension already built an ephemeral association graph from duplicate titles, entities, domains, title terms, URL terms, and page summaries.",
    "Use the provisional graph clusters as evidence. You may merge or split them, but do not fall back to generic labels like Work, Reading, or Research when a project/task label is visible.",
    "Good labels look like: Step Up: Mastery & Session Experience, Jimmy AI: Infra & Billing, Quick Response Plumbing: Local Services Research.",
    "Return JSON only.",
    "Rules:",
    "- Assign every tab ID exactly once.",
    "- Prefer active workstream labels over app/domain labels.",
    "- Use 2 to 12 groups unless there are fewer than 2 tabs.",
    "- Keep group names under 52 characters.",
    "- Include 2 to 6 short signals that explain why the group exists.",
    "- Use Other only when a tab truly does not fit.",
    "- Confidence must be a number from 0 to 1."
  ].join("\n");

  const requestTimeoutMs = chooseLlmTimeoutMs(tabs.length, settings);
  const response = await fetchWithTimeout(OPENAI_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      reasoning_effort: "minimal",
      prompt_cache_key: "neat-freak-categorizer",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "tab_workstream_groups",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["groups"],
            properties: {
              groups: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["name", "description", "confidence", "signals", "relatedGroupNames", "tabIds"],
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                    confidence: { type: "number" },
                    signals: {
                      type: "array",
                      items: { type: "string" }
                    },
                    relatedGroupNames: {
                      type: "array",
                      items: { type: "string" }
                    },
                    tabIds: {
                      type: "array",
                      items: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: JSON.stringify({ tabs: payloadTabs, provisionalClusters }) }
      ]
    })
  }, requestTimeoutMs);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${truncateText(body, 220)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned an empty response.");

  const parsed = JSON.parse(extractJson(content));
  const categories = withRelatedGroups(normalizeLlmGroups(parsed.groups, tabs), tabs);

  return {
    categories,
    meta: {
      associationGraph: summarizeGraph(associationGraph),
      error: "",
      method: "llm-graph",
      model: LLM_MODEL,
      usage: data.usage || null
    }
  };
}

export function graphCategorize(tabs, associationGraph) {
  const categories = associationGraph.clusters.map((cluster) => ({
    id: slugify(cluster.provisionalName),
    name: cluster.provisionalName,
    description: describeCluster(cluster),
    confidence: cluster.confidence,
    signals: cluster.topTerms.slice(0, 6),
    relatedClusterIds: cluster.relatedClusterIds,
    tabIds: cluster.tabIds
  }));

  return {
    categories: withRelatedGroups(ensureUniqueCategoryIds(categories), tabs),
    meta: {
      associationGraph: summarizeGraph(associationGraph),
      error: "",
      method: "association-graph"
    }
  };
}

export function buildAssociationGraph(tabs) {
  const profiles = tabs.map((tab, index) => createTabProfile(tab, index));
  const unionFind = new UnionFind(profiles.map((profile) => profile.id));
  const edges = [];

  for (let i = 0; i < profiles.length; i += 1) {
    for (let j = i + 1; j < profiles.length; j += 1) {
      const edge = scoreProfiles(profiles[i], profiles[j]);
      if (edge.score >= 0.22) edges.push(edge);
      if (edge.score >= ASSOCIATION_THRESHOLD) {
        unionFind.union(profiles[i].id, profiles[j].id);
      }
    }
  }

  const components = new Map();
  for (const profile of profiles) {
    const root = unionFind.find(profile.id);
    const current = components.get(root) || [];
    current.push(profile);
    components.set(root, current);
  }

  const initialClusters = [...components.values()]
    .map((clusterProfiles, index) => summarizeCluster(clusterProfiles, edges, index + 1))
  const clusters = mergeClustersByTheme(initialClusters)
    .sort((a, b) => b.tabIds.length - a.tabIds.length || a.provisionalName.localeCompare(b.provisionalName));

  attachClusterRelations(clusters, profiles);

  return {
    clusters,
    edgeCount: edges.length,
    topEdges: edges
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(({ source, target, score, reasons }) => ({ source, target, score: roundScore(score), reasons }))
  };
}

function createTabProfile(tab, index) {
  const titleBase = stripProductSuffix(tab.title || tab.url || "Untitled");
  const urlParts = getUrlParts(tab.url);
  const text = [titleBase, tab.domain, urlParts.pathText, tab.pageSummary].filter(Boolean).join(" ");
  const tokens = tokenize(text);
  const titleTokens = tokenize(titleBase);
  const entities = extractEntities(titleBase, text);
  const phrases = extractPhrases(titleTokens);
  const domain = tab.domain || getDomain(tab.url);

  return {
    id: tab.id,
    domain,
    domainFamily: getDomainFamily(domain),
    entities,
    highValueTokens: new Set(tokens.filter(isHighValueToken)),
    index: Number.isFinite(tab.index) ? tab.index : index,
    phrases,
    tab,
    titleBase,
    titleFingerprint: fingerprintTitle(titleBase),
    tokens: new Set(tokens),
    windowId: tab.windowId
  };
}

function scoreProfiles(a, b) {
  const reasons = [];
  let score = 0;

  if (a.titleFingerprint && a.titleFingerprint === b.titleFingerprint) {
    score += 1.25;
    reasons.push("same title");
  }

  const sharedEntities = intersection([...a.entities.keys()], [...b.entities.keys()]);
  for (const entity of sharedEntities.slice(0, 4)) {
    const weight = (a.entities.get(entity)?.broad || b.entities.get(entity)?.broad) ? 0.32 : 0.82;
    score += weight;
    reasons.push(`shared entity: ${entity}`);
  }

  const sharedPhrases = intersection([...a.phrases], [...b.phrases])
    .filter((phrase) => !isGenericPhrase(phrase))
    .slice(0, 3);
  for (const phrase of sharedPhrases) {
    const weight = phrase.split(" ").length >= 3 ? 0.52 : 0.42;
    score += weight;
    reasons.push(`shared phrase: ${phrase}`);
  }

  const sharedTokens = intersection([...a.highValueTokens], [...b.highValueTokens])
    .filter((token) => !isGenericToken(token));
  if (sharedTokens.length) {
    score += Math.min(0.46, sharedTokens.length * 0.12);
    reasons.push(`shared terms: ${sharedTokens.slice(0, 4).join(", ")}`);
  }

  if (a.domain && a.domain === b.domain) {
    score += GENERIC_DOMAINS.has(a.domain) ? 0.08 : 0.34;
    reasons.push(`same domain: ${a.domain}`);
  } else if (a.domainFamily && a.domainFamily === b.domainFamily && !isGenericDomainFamily(a.domainFamily)) {
    score += 0.18;
    reasons.push(`same domain family: ${a.domainFamily}`);
  }

  if (a.windowId === b.windowId && Math.abs(a.index - b.index) <= 3) {
    score += 0.1;
    reasons.push("nearby tabs");
  }

  return {
    source: a.id,
    target: b.id,
    score,
    reasons
  };
}

function summarizeCluster(clusterProfiles, edges, index) {
  const tabIds = clusterProfiles.map((profile) => profile.id);
  const topEntities = topValues(clusterProfiles.flatMap((profile) => [...profile.entities.keys()]), 5);
  const topPhrases = topValues(clusterProfiles.flatMap((profile) => [...profile.phrases]), 8)
    .filter((phrase) => !isGenericPhrase(phrase));
  const topTokens = topValues(clusterProfiles.flatMap((profile) => [...profile.highValueTokens]), 8)
    .filter((token) => !isGenericToken(token));
  const topDomains = topValues(clusterProfiles.map((profile) => profile.domain).filter(Boolean), 4);
  const topTerms = uniqueList([...topEntities, ...topPhrases, ...topTokens]).slice(0, 8);
  const provisionalName = deriveClusterName(clusterProfiles, topTerms, topDomains);
  const intraEdges = edges.filter((edge) => tabIds.includes(edge.source) && tabIds.includes(edge.target));
  const avgEdge = intraEdges.length
    ? intraEdges.reduce((sum, edge) => sum + edge.score, 0) / intraEdges.length
    : 0.22;
  const confidence = Math.max(0.32, Math.min(0.95, 0.42 + Math.min(0.38, avgEdge / 3) + Math.min(0.15, clusterProfiles.length * 0.015)));

  return {
    id: `cluster-${index}`,
    confidence: roundScore(confidence),
    evidenceTitles: clusterProfiles.slice(0, 5).map((profile) => truncateText(profile.titleBase, 90)),
    profileIds: tabIds,
    relatedClusterIds: [],
    scope: chooseScope(clusterProfiles),
    tabIds,
    topDomains,
    topEntities,
    topTerms,
    intent: chooseIntent(clusterProfiles),
    provisionalName
  };
}

function deriveClusterName(clusterProfiles, topTerms, topDomains) {
  const scope = chooseScope(clusterProfiles);
  const intent = chooseIntent(clusterProfiles);
  const phrase = topTerms.find((term) => !isGenericPhrase(term) && term.split(" ").length >= 2);
  const domain = topDomains.find((value) => value && !GENERIC_DOMAINS.has(value));

  if (scope && intent && !sameNormalized(scope, intent)) {
    return truncateText(`${scope}: ${intent}`, 52);
  }
  if (intent) return truncateText(scope ? `${scope}: ${intent}` : intent, 52);
  if (scope) return truncateText(scope, 52);
  if (phrase) return truncateText(toTitleCase(phrase), 52);
  if (domain) return truncateText(`${domain}: Saved Tabs`, 52);
  return clusterProfiles.length > 1 ? "Related Tabs" : "Other";
}

function chooseScope(clusterProfiles) {
  const entries = [];
  for (const profile of clusterProfiles) {
    for (const [entity, meta] of profile.entities.entries()) {
      if (meta.appOnly) continue;
      entries.push({ entity, broad: Boolean(meta.broad), alias: Boolean(meta.alias), project: Boolean(meta.project) });
    }
  }
  const counts = countValues(entries.map((entry) => entry.entity));
  const sorted = [...counts.entries()]
    .sort((a, b) => {
      const aProject = entries.some((entry) => entry.entity === a[0] && entry.project) ? 1 : 0;
      const bProject = entries.some((entry) => entry.entity === b[0] && entry.project) ? 1 : 0;
      const aAlias = entries.some((entry) => entry.entity === a[0] && entry.alias) ? 1 : 0;
      const bAlias = entries.some((entry) => entry.entity === b[0] && entry.alias) ? 1 : 0;
      return bProject - aProject || bAlias - aAlias || b[1] - a[1] || b[0].length - a[0].length;
    });

  const specific = sorted.find(([entity]) => entries.some((entry) => entry.entity === entity && !entry.broad));
  const broad = sorted.find(([entity]) => entries.some((entry) => entry.entity === entity && entry.broad));
  return specific?.[0] || broad?.[0] || "";
}

function chooseIntent(clusterProfiles) {
  const haystack = clusterProfiles
    .map((profile) => [profile.titleBase, [...profile.highValueTokens].join(" "), [...profile.phrases].join(" "), [...profile.entities.keys()].join(" ")].join(" "))
    .join(" ")
    .toLowerCase();

  let best = null;
  for (const rule of INTENT_RULES) {
    const score = rule.terms.reduce((sum, term) => sum + (haystack.includes(term.toLowerCase()) ? 1 : 0), 0);
    const strongHit = rule.terms.some((term) => STRONG_INTENT_TERMS.has(term) && haystack.includes(term.toLowerCase()));
    if ((score >= 2 || strongHit) && (!best || score > best.score)) {
      best = { label: rule.label, score };
    }
  }
  return best?.label || "";
}

function mergeClustersByTheme(clusters) {
  const buckets = new Map();
  const singles = [];

  for (const cluster of clusters) {
    const key = cluster.intent ? `intent:${slugify(cluster.intent)}` : cluster.scope ? `scope:${slugify(cluster.scope)}` : "";
    if (!key) {
      singles.push(cluster);
      continue;
    }
    const current = buckets.get(key) || [];
    current.push(cluster);
    buckets.set(key, current);
  }

  const merged = [];
  for (const bucket of buckets.values()) {
    if (bucket.length === 1) {
      merged.push(bucket[0]);
      continue;
    }
    merged.push(mergeClusterBucket(bucket));
  }

  return [...merged, ...singles].map((cluster, index) => ({ ...cluster, id: `cluster-${index + 1}` }));
}

function mergeClusterBucket(bucket) {
  const tabIds = uniqueList(bucket.flatMap((cluster) => cluster.tabIds));
  const scope = chooseBucketScope(bucket);
  const intent = bucket.find((cluster) => cluster.intent)?.intent || "";
  const topTerms = uniqueList(bucket.flatMap((cluster) => cluster.topTerms)).slice(0, 8);
  const topEntities = uniqueList(bucket.flatMap((cluster) => cluster.topEntities)).slice(0, 5);
  const topDomains = uniqueList(bucket.flatMap((cluster) => cluster.topDomains)).slice(0, 4);
  const provisionalName = intent
    ? truncateText(scope && !sameNormalized(scope, intent) ? `${scope}: ${intent}` : intent, 52)
    : truncateText(scope || bucket[0].provisionalName, 52);
  const confidence = Math.max(...bucket.map((cluster) => Number(cluster.confidence) || 0.4));

  return {
    id: bucket[0].id,
    confidence: roundScore(Math.min(0.95, confidence + Math.min(0.1, bucket.length * 0.02))),
    evidenceTitles: uniqueList(bucket.flatMap((cluster) => cluster.evidenceTitles)).slice(0, 5),
    profileIds: tabIds,
    relatedClusterIds: [],
    scope,
    tabIds,
    topDomains,
    topEntities,
    topTerms,
    intent,
    provisionalName
  };
}

function chooseBucketScope(bucket) {
  const project = weightedBucketEntity(bucket, (alias) => alias.project);
  if (project) return project;
  const aliasScope = weightedBucketEntity(bucket, (alias) => !alias.broad);
  if (aliasScope) return aliasScope;
  return "";
}

function weightedBucketEntity(bucket, predicate) {
  const counts = new Map();
  for (const cluster of bucket) {
    const weight = cluster.tabIds.length;
    for (const entity of cluster.topEntities) {
      const alias = ENTITY_ALIASES.find((candidate) => candidate.label === entity);
      if (!alias || !predicate(alias)) continue;
      counts.set(entity, (counts.get(entity) || 0) + weight);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0] || "";
}

function describeCluster(cluster) {
  const terms = cluster.topTerms.slice(0, 4);
  if (terms.length) return `Connected by ${terms.join(", ")}.`;
  if (cluster.topDomains.length) return `Connected by ${cluster.topDomains.join(", ")}.`;
  return "A small temporary association cluster.";
}

function attachClusterRelations(clusters, profiles) {
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const clusterSignals = clusters.map((cluster) => ({
    id: cluster.id,
    signals: new Set(cluster.tabIds.flatMap((tabId) => {
      const profile = profileById.get(tabId);
      if (!profile) return [];
      return [
        ...profile.highValueTokens,
        ...profile.phrases,
        ...profile.entities.keys(),
        profile.domain
      ].filter(Boolean);
    }))
  }));

  for (const cluster of clusters) {
    const current = clusterSignals.find((item) => item.id === cluster.id);
    const related = clusterSignals
      .filter((item) => item.id !== cluster.id)
      .map((item) => ({ id: item.id, score: jaccard(current.signals, item.signals) }))
      .filter((item) => item.score >= 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((item) => item.id);
    cluster.relatedClusterIds = related;
  }
}

function withRelatedGroups(categories, tabs) {
  const profileByTabId = new Map(tabs.map((tab, index) => [tab.id, createTabProfile(tab, index)]));
  const signalsByCategory = categories.map((category) => ({
    id: category.id,
    name: category.name,
    signals: new Set([
      ...(category.signals || []),
      ...category.tabIds.flatMap((tabId) => {
        const profile = profileByTabId.get(tabId);
        if (!profile) return [];
        return [...profile.highValueTokens, ...profile.phrases, ...profile.entities.keys(), profile.domain].filter(Boolean);
      })
    ])
  }));

  return categories.map((category) => {
    const current = signalsByCategory.find((item) => item.id === category.id);
    const relatedGroupNames = signalsByCategory
      .filter((item) => item.id !== category.id)
      .map((item) => ({ name: item.name, score: jaccard(current.signals, item.signals) }))
      .filter((item) => item.score >= 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((item) => item.name);
    return {
      ...category,
      relatedGroupNames: uniqueList([...(category.relatedGroupNames || []), ...relatedGroupNames]).slice(0, 2)
    };
  });
}

function normalizeLlmGroups(groups, tabs) {
  const knownIds = new Set(tabs.map((tab) => tab.id));
  const assigned = new Set();
  const categories = [];

  for (const group of Array.isArray(groups) ? groups : []) {
    const name = truncateText(group.name || "Other", 52);
    const tabIds = [...new Set(Array.isArray(group.tabIds) ? group.tabIds : [])]
      .filter((tabId) => knownIds.has(tabId) && !assigned.has(tabId));

    if (!tabIds.length) continue;
    tabIds.forEach((tabId) => assigned.add(tabId));
    categories.push({
      id: uniqueCategoryId(name, categories),
      name,
      description: truncateText(group.description || "", 160),
      confidence: clampConfidence(group.confidence),
      signals: Array.isArray(group.signals) ? group.signals.slice(0, 6).map((signal) => truncateText(signal, 40)) : [],
      relatedGroupNames: Array.isArray(group.relatedGroupNames) ? group.relatedGroupNames.slice(0, 2).map((nameValue) => truncateText(nameValue, 52)) : [],
      tabIds
    });
  }

  const missing = tabs.filter((tab) => !assigned.has(tab.id)).map((tab) => tab.id);
  if (missing.length) {
    categories.push({
      id: uniqueCategoryId("Other", categories),
      name: "Other",
      description: "Tabs not assigned by the LLM response.",
      confidence: 0.2,
      signals: [],
      relatedGroupNames: [],
      tabIds: missing
    });
  }

  return categories.length ? ensureUniqueCategoryIds(categories) : graphCategorize(tabs, buildAssociationGraph(tabs)).categories;
}

function extractEntities(titleBase, fullText) {
  const entities = new Map();
  for (const alias of ENTITY_ALIASES) {
    if (alias.patterns.some((pattern) => pattern.test(fullText))) {
      entities.set(alias.label, { alias: true, broad: Boolean(alias.broad), appOnly: Boolean(alias.appOnly), project: Boolean(alias.project) });
    }
  }

  for (const phrase of titleCasePhrases(titleBase)) {
    const normalized = normalizeEntityName(phrase);
    if (normalized && !entities.has(normalized) && !isGenericPhrase(normalized.toLowerCase())) {
      entities.set(normalized, { alias: false, broad: false, appOnly: false });
    }
  }
  return entities;
}

function titleCasePhrases(value) {
  return String(value || "")
    .split(/[|•/()[\]{}]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 8)
    .flatMap((segment) => {
      const match = segment.match(/\b[A-Z][A-Za-z0-9&'.]*(?:\s+(?:and|of|for|to|the|AI|BTS|[A-Z][A-Za-z0-9&'.]*)){1,5}/g);
      return match || [];
    })
    .map((phrase) => phrase.replace(/\s+/g, " ").trim())
    .filter((phrase) => phrase.split(" ").length >= 2);
}

function extractPhrases(tokens) {
  const phrases = new Set();
  const cleanTokens = tokens.filter((token) => !STOP_WORDS.has(token));
  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index <= cleanTokens.length - size; index += 1) {
      const phrase = cleanTokens.slice(index, index + size).join(" ");
      if (phrase.length >= 8 && !isGenericPhrase(phrase)) phrases.add(phrase);
    }
  }
  return phrases;
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[_+./:?=&%#-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function isHighValueToken(token) {
  if (token === "ai") return true;
  return token.length >= 3 && !STOP_WORDS.has(token) && !/^\d+$/.test(token);
}

function isGenericToken(token) {
  return STOP_WORDS.has(token) || ["com", "www", "html", "login", "auth", "callback"].includes(token);
}

function isGenericPhrase(phrase) {
  const normalized = phrase.toLowerCase();
  if (!normalized || normalized.length < 4) return true;
  if (["google docs", "google sheets", "google slides", "google search", "admin console", "file found", "page blocked"].includes(normalized)) return true;
  const tokens = normalized.split(/\s+/);
  return tokens.every((token) => STOP_WORDS.has(token));
}

function stripProductSuffix(title) {
  let value = String(title || "").trim();
  for (const pattern of PRODUCT_SUFFIX_PATTERNS) {
    value = value.replace(pattern, "");
  }
  return value.replace(/\s+/g, " ").trim();
}

function fingerprintTitle(value) {
  const tokens = tokenize(stripProductSuffix(value)).filter(isHighValueToken);
  if (tokens.length < 2) return "";
  return tokens.join(" ");
}

function getUrlParts(url) {
  try {
    const parsed = new URL(url);
    const pathText = decodeURIComponent(parsed.pathname)
      .replace(/[/-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { pathText };
  } catch {
    return { pathText: "" };
  }
}

function getDomainFamily(domain) {
  const parts = String(domain || "").split(".").filter(Boolean);
  if (parts.length <= 2) return domain || "";
  return parts.slice(-2).join(".");
}

function isGenericDomainFamily(domainFamily) {
  return ["google.com", "googleusercontent.com"].includes(domainFamily);
}

function normalizeEntityName(value) {
  return String(value || "")
    .replace(/\s+-\s+.*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bAi\b/g, "AI")
    .replace(/\bBts\b/g, "BTS");
}

function topValues(values, limit) {
  return [...countValues(values).entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([value]) => value);
}

function countValues(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item));
}

function uniqueList(values) {
  return [...new Set(values.filter(Boolean))];
}

function jaccard(left, right) {
  if (!left?.size || !right?.size) return 0;
  const shared = [...left].filter((value) => right.has(value)).length;
  const union = new Set([...left, ...right]).size;
  return union ? shared / union : 0;
}

function sameNormalized(left, right) {
  return slugify(left) === slugify(right);
}

function toTitleCase(value) {
  return String(value || "")
    .split(/\s+/)
    .map((word) => {
      if (word === "ai") return "AI";
      if (word === "bts") return "BTS";
      return word.slice(0, 1).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function ensureUniqueCategoryIds(categories) {
  const next = [];
  for (const category of categories) {
    next.push({
      ...category,
      id: uniqueCategoryId(category.name || category.id, next)
    });
  }
  return next;
}

function uniqueCategoryId(name, categories) {
  const base = slugify(name);
  let id = base;
  let index = 2;
  while (categories.some((category) => category.id === id)) {
    id = `${base}-${index}`;
    index += 1;
  }
  return id;
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.max(0, Math.min(1, number));
}

function roundScore(value) {
  return Math.round(value * 100) / 100;
}

function summarizeGraph(associationGraph) {
  return {
    clusterCount: associationGraph.clusters.length,
    edgeCount: associationGraph.edgeCount,
    topEdges: associationGraph.topEdges
  };
}

function extractJson(content) {
  const trimmed = String(content).trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function fetchWithTimeout(url, options, timeoutMs = 180000) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .catch((error) => {
      if (error?.name === "AbortError" || /aborted|signal is aborted/i.test(error?.message || "")) {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        throw new Error(`LLM request timed out after ~${elapsedSec}s (limit ${Math.round(timeoutMs / 1000)}s). Neat Freak used local graph grouping instead.`);
      }
      throw error;
    })
    .finally(() => clearTimeout(timeout));
}

function chooseLlmTimeoutMs(tabCount, settings) {
  const override = Number(settings?.llmTimeoutMs);
  if (Number.isFinite(override) && override >= 30000) return override;
  if (tabCount >= 120) return 240000;
  if (tabCount >= 60) return 180000;
  if (tabCount >= 25) return 120000;
  return 90000;
}

function chooseSnippetBudget(tabCount, requested) {
  const base = Number.isFinite(requested) && requested > 0 ? requested : 720;
  if (tabCount >= 120) return Math.min(base, 280);
  if (tabCount >= 60) return Math.min(base, 420);
  if (tabCount >= 25) return Math.min(base, 560);
  return base;
}

function normalizeLlmError(error) {
  const message = error?.message || String(error || "");
  if (/aborted|signal is aborted/i.test(message)) {
    return "LLM request timed out. Neat Freak used local graph grouping instead. Try a faster model or fewer tabs.";
  }
  return message;
}

class UnionFind {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }

  find(id) {
    const parent = this.parent.get(id);
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }
}
