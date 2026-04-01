var http = require("http");
var fs = require("fs");
var path = require("path");
var fetch = require("node-fetch");

// Load .env
try {
  var ef = path.join(__dirname, ".env");
  if (fs.existsSync(ef)) {
    fs.readFileSync(ef, "utf8").split("\n").forEach(function(line) {
      var i = line.indexOf("=");
      if (i > 0) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
  }
} catch(e) {}

var TOKEN = process.env.GITHUB_TOKEN;
var REPO = process.env.GITHUB_REPO || "InspireHUB/IHUB_Platform";
var AI_KEY = process.env.ANTHROPIC_API_KEY;
var GEMINI_KEY = process.env.GEMINI_API_KEY;
var OPENAI_KEY = process.env.OPENAI_API_KEY;
var PORT = process.env.PORT || 3000;
var CHERRY_PICK_TARGET = process.env.CHERRY_PICK_TARGET || "release/v5.9.3";

if (!TOKEN) { console.error("Missing GITHUB_TOKEN in .env"); process.exit(1); }

var SKIP_EXT = [".json", ".lock", ".snap", ".map", ".min.js", ".min.css"];
var SKIP_PATTERN = [".spec.ts", ".spec.js", ".test.ts", ".test.js", ".test.tsx", ".test.jsx", ".stories.tsx", ".stories.ts"];

function skipFile(name) {
  if (SKIP_EXT.some(function(e) { return name.endsWith(e); })) return true;
  if (SKIP_PATTERN.some(function(p) { return name.endsWith(p); })) return true;
  if (name.includes("__tests__") || name.includes("__mocks__") || name.includes("__snapshots__")) return true;
  return false;
}

async function gh(ep, accept) {
  var r = await fetch("https://api.github.com/repos/" + REPO + ep, {
    headers: { Authorization: "token " + TOKEN, Accept: accept || "application/vnd.github.v3+json" }
  });
  if (!r.ok) throw new Error("GitHub " + r.status + " " + r.statusText);
  return accept ? r.text() : r.json();
}

async function ghPost(ep, body) {
  var r = await fetch("https://api.github.com/repos/" + REPO + ep, {
    method: "POST",
    headers: { Authorization: "token " + TOKEN, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) { var t = await r.text(); throw new Error("GitHub POST " + r.status + " " + ep + ": " + t); }
  return r.json();
}

async function ghPatch(ep, body) {
  var r = await fetch("https://api.github.com/repos/" + REPO + ep, {
    method: "PATCH",
    headers: { Authorization: "token " + TOKEN, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) { var t = await r.text(); throw new Error("GitHub PATCH " + r.status + " " + ep + ": " + t); }
  return r.json();
}

async function ghDelete(ep) {
  var r = await fetch("https://api.github.com/repos/" + REPO + ep, {
    method: "DELETE",
    headers: { Authorization: "token " + TOKEN, Accept: "application/vnd.github.v3+json" }
  });
  if (!r.ok && r.status !== 204) { var t = await r.text(); throw new Error("GitHub DELETE " + r.status + " " + ep + ": " + t); }
}

async function cherryPickPR(prNum, targetBranch) {
  // 1. Get PR to find merge commit
  var pr = await gh("/pulls/" + prNum);
  if (!pr.merged) throw new Error("PR #" + prNum + " is not merged yet. Squash-merge it first.");
  var mergeSha = pr.merge_commit_sha;

  // 2. Get merge commit details (tree, parent, message)
  var mergeCommit = await gh("/git/commits/" + mergeSha);
  var parentSha = mergeCommit.parents[0].sha;
  var parentCommit = await gh("/git/commits/" + parentSha);
  var parentTree = parentCommit.tree.sha;

  // 3. Get target branch HEAD
  var targetRef = await gh("/git/ref/heads/" + targetBranch);
  var targetHead = targetRef.object.sha;

  // 4. Create temp commit: parent's tree on top of target HEAD
  var tempCommit = await ghPost("/git/commits", {
    tree: parentTree,
    parents: [targetHead],
    message: "temp base for cherry-pick"
  });

  // 5. Create temp branch at that commit
  var tempBranch = "temp-cherry-pick-" + prNum + "-" + Date.now();
  await ghPost("/git/refs", {
    ref: "refs/heads/" + tempBranch,
    sha: tempCommit.sha
  });

  try {
    // 6. Merge the squash commit into temp branch (applies the diff)
    var mergeResult = await ghPost("/merges", {
      base: tempBranch,
      head: mergeSha,
      commit_message: mergeCommit.message
    });

    // 7. Get the resulting tree
    var mergeResultCommit = await gh("/git/commits/" + mergeResult.sha);
    var resultTree = mergeResultCommit.tree.sha;

    // 8. Create clean single-parent cherry-pick commit on target
    var cherryCommit = await ghPost("/git/commits", {
      tree: resultTree,
      parents: [targetHead],
      message: mergeCommit.message + "\n\n(cherry picked from " + mergeSha.substring(0, 7) + ", PR #" + prNum + ")"
    });

    // 9. Fast-forward target branch
    await ghPatch("/git/refs/heads/" + targetBranch, {
      sha: cherryCommit.sha
    });

    return { sha: cherryCommit.sha, message: mergeCommit.message, targetBranch: targetBranch };
  } finally {
    // 10. Always clean up temp branch
    try { await ghDelete("/git/refs/heads/" + tempBranch); } catch(e) {}
  }
}

async function getFiles(prNum) {
  var all = await gh("/pulls/" + prNum + "/files?per_page=100");
  var kept = all.filter(function(f) { return !skipFile(f.filename); });
  var skipped = all.filter(function(f) { return skipFile(f.filename); });
  return {
    total: all.length,
    kept: kept.map(function(f) { return f.filename; }),
    skipped: skipped.map(function(f) { return f.filename; })
  };
}

function filterDiff(raw) {
  var sections = raw.split(/(?=^diff --git )/m);
  var filtered = sections.filter(function(s) {
    var m = s.match(/^diff --git a\/(.+?) b\//);
    return !m || !skipFile(m[1]);
  });
  var result = filtered.join("");
  return result.length > 28000 ? result.substring(0, 28000) + "\n...(truncated)" : result;
}

// API: list PRs from last 2 weeks (no file fetching — fast)
async function listPRs() {
  var twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  var prs = await gh("/pulls?state=open&sort=created&direction=desc&per_page=100");
  var recent = prs.filter(function(pr) { return pr.created_at >= twoWeeksAgo; });

  return recent.map(function(pr) {
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body || "",
      author: pr.user.login,
      avatar: pr.user.avatar_url,
      branch: pr.head.ref,
      base: pr.base.ref,
      created_at: pr.created_at,
      html_url: pr.html_url
    };
  });
}

// API: list recently merged PRs
async function listMergedPRs() {
  var prs = await gh("/pulls?state=closed&sort=updated&direction=desc&per_page=30");
  var merged = prs.filter(function(pr) { return pr.merged_at; }).slice(0, 10);

  // Clean up review cache for merged PRs
  merged.forEach(function(pr) {
    var file = path.join(REVIEWS_DIR, pr.number + ".json");
    if (fs.existsSync(file)) {
      try { fs.unlinkSync(file); } catch(e) {}
    }
  });

  return merged.map(function(pr) {
    return {
      number: pr.number,
      title: pr.title,
      body: pr.body || "",
      author: pr.user.login,
      avatar: pr.user.avatar_url,
      branch: pr.head.ref,
      base: pr.base.ref,
      merged_at: pr.merged_at,
      html_url: pr.html_url,
      merged: true
    };
  });
}

// Review cache
var REVIEWS_DIR = path.join(__dirname, "reviews");
if (!fs.existsSync(REVIEWS_DIR)) fs.mkdirSync(REVIEWS_DIR);

function getCachedReview(prNum) {
  var file = path.join(REVIEWS_DIR, prNum + ".json");
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch(e) { return null; }
}

function saveCachedReview(prNum, result) {
  var existing = getCachedReview(prNum);
  var data = { reviewed_at: new Date().toISOString(), human_reviewed: existing ? !!existing.human_reviewed : false, result: result };
  fs.writeFileSync(path.join(REVIEWS_DIR, prNum + ".json"), JSON.stringify(data, null, 2), "utf8");
  return data;
}

function setHumanReviewed(prNum, value) {
  var file = path.join(REVIEWS_DIR, prNum + ".json");
  var data;
  if (fs.existsSync(file)) {
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch(e) { data = {}; }
  } else {
    data = {};
  }
  data.human_reviewed = !!value;
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  return data;
}

// Review prompt (shared across providers)
var REVIEW_PROMPT = "You are a senior code reviewer. Analyze this PR diff for ONLY medium, high, or critical severity bugs and security issues.\n\n"
  + "Do NOT report: style issues, formatting, naming, low-severity items, test files, or json changes.\n\n"
  + "Respond ONLY with valid JSON (no markdown, no backticks):\n"
  + '{"summary":"Brief assessment","issues":[{"severity":"medium|high|critical","category":"bug|security","file":"filename","line":"line","title":"title","description":"explanation","suggestion":"code fix"}],"risk_score":1}\n\n';

function buildPrompt(pr, diff) {
  return REVIEW_PROMPT + "PR: " + pr.title + " (#" + pr.number + ")\nBranch: " + pr.head.ref + " -> " + pr.base.ref + "\nAuthor: " + pr.user.login + "\n\nDIFF:\n" + diff;
}

// Provider: Claude
async function callClaude(prompt) {
  if (!AI_KEY) throw new Error("ANTHROPIC_API_KEY not set in .env");
  var r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": AI_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 4000,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!r.ok) { var t = await r.text(); throw new Error("Claude API " + r.status + ": " + t); }
  var d = await r.json();
  return d.content.map(function(c) { return c.text || ""; }).join("");
}

// Provider: Gemini
async function callGemini(prompt) {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY not set in .env");
  var r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_KEY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 4000 }
    })
  });
  if (!r.ok) { var t = await r.text(); throw new Error("Gemini API " + r.status + ": " + t); }
  var d = await r.json();
  return d.candidates[0].content.parts.map(function(p) { return p.text || ""; }).join("");
}

// Provider: GPT
async function callGPT(prompt) {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not set in .env");
  var r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + OPENAI_KEY },
    body: JSON.stringify({
      model: "gpt-4o", max_tokens: 4000,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!r.ok) { var t = await r.text(); throw new Error("GPT API " + r.status + ": " + t); }
  var d = await r.json();
  return d.choices[0].message.content;
}

var PROVIDERS = { claude: callClaude, gemini: callGemini, gpt: callGPT };

// API: review a single PR with a chosen provider
async function reviewPR(prNum, provider) {
  provider = provider || "claude";
  var callFn = PROVIDERS[provider];
  if (!callFn) throw new Error("Unknown provider: " + provider);

  var prs = await gh("/pulls?state=open&per_page=100");
  var pr = prs.find(function(p) { return p.number === prNum; });
  if (!pr) throw new Error("PR #" + prNum + " not found");

  var rawDiff = await gh("/pulls/" + prNum, "application/vnd.github.v3.diff");
  var diff = filterDiff(rawDiff);

  if (diff.trim().length < 10) {
    return { provider: provider, summary: "No reviewable code changes after filtering.", issues: [], risk_score: 0 };
  }

  var prompt = buildPrompt(pr, diff);
  var txt = await callFn(prompt);
  var parsed = JSON.parse(txt.replace(/```json|```/g, "").trim());
  parsed.provider = provider;
  var cached = saveCachedReview(prNum, parsed);
  parsed.reviewed_at = cached.reviewed_at;
  return parsed;
}

// HTML page
function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PR Review Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #08080d; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  .container { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
  .subtitle { font-size: 13px; color: #64748b; margin-bottom: 28px; }
  .loading { text-align: center; padding: 60px; color: #64748b; font-size: 14px; }
  .spinner { display: inline-block; width: 20px; height: 20px; border: 2px solid #334155; border-top-color: #818cf8; border-radius: 50%; animation: spin .6s linear infinite; margin-right: 8px; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .pr-card { background: #111118; border: 1px solid #1e1e2e; border-radius: 12px; margin-bottom: 12px; overflow: hidden; transition: border-color .2s; }
  .pr-card:hover { border-color: #2d2d44; }
  .pr-header { padding: 16px 20px; display: flex; align-items: center; gap: 12px; }
  .pr-avatar { width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0; }
  .pr-info { flex: 1; min-width: 0; }
  .pr-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pr-number { color: #475569; font-size: 12px; font-weight: 600; }
  .pr-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pr-title a { color: inherit; text-decoration: none; }
  .pr-title a:hover { color: #818cf8; text-decoration: underline; }
  .pr-meta { font-size: 11px; color: #475569; margin-top: 3px; }
  .pr-meta a { color: #818cf8; text-decoration: none; }

  .pr-files { padding: 0 20px 12px; display: flex; gap: 16px; flex-wrap: wrap; }
  .file-group { font-size: 12px; }
  .file-group-label { color: #64748b; font-weight: 600; margin-bottom: 4px; }
  .file-list { list-style: none; }
  .file-list li { color: #94a3b8; font-family: monospace; font-size: 11px; padding: 1px 0; }
  .file-list li.skipped { color: #475569; text-decoration: line-through; }
  .file-toggle { background: none; border: none; color: #818cf8; font-size: 11px; cursor: pointer; padding: 2px 0; }
  .file-toggle:hover { text-decoration: underline; }

  .pr-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
  .btn-review { color: #fff; border: none; padding: 8px 14px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; transition: background .2s; }
  .btn-review:disabled { background: #334155; color: #64748b; cursor: not-allowed; }
  .btn-review.reviewing { background: #334155; color: #64748b; }
  .btn-review.claude { background: #d97706; }
  .btn-review.claude:hover:not(:disabled) { background: #b45309; }
  .btn-review.gemini { background: #2563eb; }
  .btn-review.gemini:hover:not(:disabled) { background: #1d4ed8; }
  .btn-review.gpt { background: #16a34a; }
  .btn-review.gpt:hover:not(:disabled) { background: #15803d; }
  .pr-card.collapsed .btn-review { padding: 4px 8px; font-size: 10px; }
  .btn-github { background: #1e1e2e; color: #e2e8f0; border: 1px solid #334155; padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none; transition: background .2s; display: inline-flex; align-items: center; gap: 5px; }
  .btn-github:hover { background: #2d2d44; }
  .jira-badge { display: inline-block; font-size: 11px; padding: 3px 10px; border-radius: 99px; font-weight: 600; background: rgba(129,140,248,.12); color: #818cf8; text-decoration: none; margin-left: 6px; }
  .jira-badge:hover { background: rgba(129,140,248,.25); }

  .review-result { padding: 0 20px 16px; }
  .review-block { margin-bottom: 4px; }
  .review-toggle { font-size: 10px; color: #475569; margin-right: 2px; }
  .review-summary { font-size: 13px; color: #94a3b8; padding: 12px 0; border-top: 1px solid #1e1e2e; }
  .review-summary:hover { background: rgba(255,255,255,.02); }
  .review-badge { display: inline-block; font-size: 11px; padding: 3px 10px; border-radius: 99px; font-weight: 600; margin-left: 8px; }
  .badge-clean { background: rgba(74,222,128,.12); color: #4ade80; }
  .badge-issues { background: rgba(250,204,21,.12); color: #facc15; }
  .badge-critical { background: rgba(248,113,113,.12); color: #f87171; }
  .risk-score { font-size: 11px; font-family: monospace; font-weight: 700; margin-left: 8px; }

  .issue-card { padding: 12px; margin: 8px 0; border-radius: 8px; }
  .issue-card.critical { border-left: 3px solid #ef4444; background: rgba(239,68,68,.08); }
  .issue-card.high { border-left: 3px solid #f97316; background: rgba(249,115,22,.08); }
  .issue-card.medium { border-left: 3px solid #eab308; background: rgba(234,179,8,.08); }
  .issue-header { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; flex-wrap: wrap; }
  .issue-severity { font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .issue-severity.critical { color: #ef4444; }
  .issue-severity.high { color: #f97316; }
  .issue-severity.medium { color: #eab308; }
  .issue-category { font-size: 11px; color: #64748b; }
  .issue-file { margin-left: auto; font-size: 11px; color: #818cf8; font-family: monospace; text-decoration: none; }
  .issue-file:hover { text-decoration: underline; color: #a5b4fc; }
  .issue-title { font-size: 13px; font-weight: 600; margin-bottom: 3px; }
  .issue-desc { font-size: 12px; color: #94a3b8; line-height: 1.5; }
  .issue-fix { margin-top: 8px; padding: 8px; background: #08080d; border: 1px solid #1e1e2e; border-radius: 6px; }
  .issue-fix-label { font-size: 10px; color: #64748b; font-weight: 600; margin-bottom: 3px; }
  .issue-fix pre { font-size: 12px; color: #86efac; white-space: pre-wrap; margin: 0; }

  .pr-checks { display: flex; gap: 12px; align-items: center; padding: 0 20px 10px; }
  .pr-check { display: flex; align-items: center; gap: 5px; font-size: 11px; color: #64748b; cursor: pointer; user-select: none; }
  .pr-check input[type=checkbox] { accent-color: #818cf8; cursor: pointer; }
  .pr-check.checked { color: #4ade80; }

  .pr-card.collapsed .pr-header { padding: 10px 20px; }
  .pr-card.collapsed .pr-files,
  .pr-card.collapsed .review-result,
  .pr-card.collapsed .pr-checks,
  .pr-card.collapsed .cherry-result { display: none; }
  .pr-card.collapsed .pr-meta { display: none; }
  .pr-card.collapsed .pr-avatar { width: 24px; height: 24px; }
  .pr-card.collapsed .pr-actions { gap: 4px; }
  .pr-card.collapsed .btn-github { padding: 4px 10px; font-size: 11px; }
  .pr-card.collapsed .collapsed-checks { display: flex; }
  .collapsed-checks { display: none; gap: 6px; align-items: center; margin-left: 8px; }
  .collapsed-check { font-size: 10px; padding: 2px 8px; border-radius: 99px; font-weight: 600; }
  .collapsed-check.ai { background: rgba(129,140,248,.12); color: #818cf8; }
  .collapsed-check.human { background: rgba(74,222,128,.12); color: #4ade80; }
  .btn-cherry { background: #1e1e2e; color: #f0abfc; border: 1px solid #7e22ce; padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; transition: background .2s; white-space: nowrap; }
  .btn-cherry:hover { background: #2d1a4e; }
  .btn-cherry:disabled { opacity: .5; cursor: not-allowed; }
  .btn-cherry.done { border-color: #4ade80; color: #4ade80; }
  .pr-card.collapsed .btn-cherry { padding: 4px 10px; font-size: 11px; }
  .cherry-result { font-size: 11px; padding: 4px 20px 8px; }
  .cherry-result.success { color: #4ade80; }
  .cherry-result.error { color: #f87171; }
  .expand-btn { background: none; border: none; color: #475569; cursor: pointer; font-size: 14px; padding: 2px 6px; line-height: 1; }
  .expand-btn:hover { color: #818cf8; }

  .merged-badge { font-size: 11px; padding: 4px 12px; border-radius: 99px; font-weight: 600; background: rgba(168,85,247,.15); color: #c084fc; }
  .merged-card .btn-cherry { display: inline-block; }

  .error-msg { color: #f87171; font-size: 12px; padding: 8px 0; }
  .no-prs { text-align: center; padding: 60px; color: #475569; }
</style>
</head>
<body>
<div class="container">
  <h1>PR Review Dashboard</h1>
  <div class="subtitle" id="subtitle">Loading...</div>
  <div id="content"><div class="loading"><span class="spinner"></span> Fetching PRs from the last 2 weeks...</div></div>
  <h2 id="merged-heading" style="font-size:18px;margin-top:32px;margin-bottom:12px;display:none">Recently Merged</h2>
  <div id="merged-content"></div>
</div>
<script>
var REPO = ${JSON.stringify(REPO)};
var targetBranch = ${JSON.stringify(CHERRY_PICK_TARGET)};

document.addEventListener('DOMContentLoaded', function() { loadPRs(); loadMergedPRs(); });

async function loadPRs() {
  try {
    var res = await fetch('/api/prs');
    if (!res.ok) throw new Error('Failed to fetch PRs');
    var prs = await res.json();
    document.getElementById('subtitle').textContent = REPO + ' | PRs created in the last 2 weeks | ' + new Date().toLocaleDateString();
    renderPRs(prs);
  } catch(e) {
    document.getElementById('content').innerHTML = '<div class="error-msg">Error: ' + esc(e.message) + '</div>';
  }
}

async function loadMergedPRs() {
  try {
    var res = await fetch('/api/merged-prs');
    if (!res.ok) return;
    var prs = await res.json();
    if (!prs.length) return;
    document.getElementById('merged-heading').style.display = '';
    renderMergedPRs(prs);
  } catch(e) { /* ignore */ }
}

function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

var JIRA_BASE = 'https://inspirehub.atlassian.net/browse/';
var GITHUB_PR = 'https://github.com/' + REPO + '/pull/';
var prMeta = {}; // num -> { branch, html_url }

async function sha256(str) {
  var buf = new TextEncoder().encode(str);
  var hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}

function extractJiraTickets(pr) {
  var text = (pr.title || '') + ' ' + (pr.branch || '') + ' ' + (pr.body || '');
  var matches = text.match(/[A-Z][A-Z0-9]+-\\d+/g);
  if (!matches) return [];
  // deduplicate
  var seen = {};
  return matches.filter(function(t) { if (seen[t]) return false; seen[t] = true; return true; });
}

function renderPRs(prs) {
  if (!prs.length) {
    document.getElementById('content').innerHTML = '<div class="no-prs">No PRs created in the last 2 weeks.</div>';
    return;
  }
  var html = '';
  prs.forEach(function(pr) {
    prMeta[pr.number] = { branch: pr.branch, html_url: pr.html_url };
    var created = new Date(pr.created_at).toLocaleDateString();
    var tickets = extractJiraTickets(pr);
    var ticketHtml = tickets.map(function(t) {
      return '<a class="jira-badge" href="' + JIRA_BASE + t + '" target="_blank">' + t + '</a>';
    }).join('');

    html += '<div class="pr-card" id="pr-' + pr.number + '">'
      + '<div class="pr-header">'
      + '<img class="pr-avatar" src="' + esc(pr.avatar) + '" alt="">'
      + '<div class="pr-info">'
      + '<div class="pr-title-row">'
      + '<span class="pr-number">#' + pr.number + '</span>'
      + '<span class="pr-title" id="pr-title-' + pr.number + '">' + esc(pr.title) + '</span>'
      + ticketHtml
      + '<div class="collapsed-checks" id="collapsed-checks-' + pr.number + '"></div>'
      + '</div>'
      + '<div class="pr-meta">' + esc(pr.author) + ' | ' + esc(pr.branch) + ' &rarr; ' + esc(pr.base) + ' | ' + created + '</div>'
      + '</div>'
      + '<div class="pr-actions">'
      + '<button class="expand-btn" id="expand-btn-' + pr.number + '" onclick="toggleCollapse(' + pr.number + ')" style="display:none" title="Expand/Collapse">&#9660;</button>'
      + '<a class="btn-github" href="' + esc(pr.html_url) + '" target="_blank">GitHub</a>'
      + '<button class="btn-review claude" id="btn-claude-' + pr.number + '" onclick="reviewPR(' + pr.number + ',\\'claude\\')">Claude</button>'
      + '<button class="btn-review gemini" id="btn-gemini-' + pr.number + '" onclick="reviewPR(' + pr.number + ',\\'gemini\\')">Gemini</button>'
      + '<button class="btn-review gpt" id="btn-gpt-' + pr.number + '" onclick="reviewPR(' + pr.number + ',\\'gpt\\')">GPT</button>'
      + '<button class="btn-cherry" id="btn-cherry-' + pr.number + '" onclick="cherryPick(' + pr.number + ')" style="display:none">Cherry-pick to ' + esc(targetBranch) + '</button>'
      + '</div>'
      + '</div>'
      + '<div class="pr-checks" id="checks-' + pr.number + '">'
      + '<label class="pr-check" id="check-ai-' + pr.number + '"><input type="checkbox" disabled id="cb-ai-' + pr.number + '"> AI Reviewed</label>'
      + '<label class="pr-check" id="check-human-' + pr.number + '"><input type="checkbox" id="cb-human-' + pr.number + '" onchange="toggleHumanReview(' + pr.number + ', this.checked)"> Human Reviewed</label>'
      + '</div>'
      + '<div class="pr-files" id="files-section-' + pr.number + '">'
      + '<span style="font-size:11px;color:#475569"><span class="spinner" style="width:12px;height:12px;border-width:1.5px"></span> Loading files...</span>'
      + '</div>'
      + '<div class="review-result" id="result-' + pr.number + '"></div>'
      + '<div id="cherry-result-' + pr.number + '"></div>'
      + '</div>';
  });
  document.getElementById('content').innerHTML = html;
  // Lazy-load file info and cached reviews for each PR
  prs.forEach(function(pr) {
    loadFiles(pr.number);
    loadCachedReview(pr.number);
  });
}

function renderMergedPRs(prs) {
  var html = '';
  prs.forEach(function(pr) {
    var merged = new Date(pr.merged_at).toLocaleDateString();
    var tickets = extractJiraTickets(pr);
    var ticketHtml = tickets.map(function(t) {
      return '<a class="jira-badge" href="' + JIRA_BASE + t + '" target="_blank">' + t + '</a>';
    }).join('');

    html += '<div class="pr-card merged-card" id="pr-' + pr.number + '">'
      + '<div class="pr-header">'
      + '<img class="pr-avatar" src="' + esc(pr.avatar) + '" alt="">'
      + '<div class="pr-info">'
      + '<div class="pr-title-row">'
      + '<span class="pr-number">#' + pr.number + '</span>'
      + '<span class="pr-title">' + esc(pr.title) + '</span>'
      + ticketHtml
      + '</div>'
      + '<div class="pr-meta">' + esc(pr.author) + ' | ' + esc(pr.branch) + ' &rarr; ' + esc(pr.base) + ' | merged ' + merged + '</div>'
      + '</div>'
      + '<div class="pr-actions">'
      + '<span class="merged-badge">Merged</span>'
      + '<a class="btn-github" href="' + esc(pr.html_url) + '" target="_blank">GitHub</a>'
      + '<button class="btn-cherry" id="btn-cherry-' + pr.number + '" onclick="cherryPick(' + pr.number + ')">Cherry-pick to ' + esc(targetBranch) + '</button>'
      + '</div>'
      + '</div>'
      + '<div id="cherry-result-' + pr.number + '"></div>'
      + '</div>';
  });
  document.getElementById('merged-content').innerHTML = html;
}

async function loadCachedReview(num) {
  try {
    var res = await fetch('/api/cached-review/' + num);
    if (res.status === 404) return;
    if (!res.ok) return;
    var data = await res.json();
    await renderReview(num, data);
    setAIChecked(num, true);
    if (data.human_reviewed) setHumanChecked(num, true);
    checkCollapse(num);
  } catch(e) { /* no cached review, ignore */ }
}

function setAIChecked(num, val) {
  var cb = document.getElementById('cb-ai-' + num);
  var label = document.getElementById('check-ai-' + num);
  if (cb) cb.checked = val;
  if (label) { if (val) label.classList.add('checked'); else label.classList.remove('checked'); }
}

function setHumanChecked(num, val) {
  var cb = document.getElementById('cb-human-' + num);
  var label = document.getElementById('check-human-' + num);
  if (cb) cb.checked = val;
  if (label) { if (val) label.classList.add('checked'); else label.classList.remove('checked'); }
}

async function toggleHumanReview(num, checked) {
  setHumanChecked(num, checked);
  checkCollapse(num);
  try {
    await fetch('/api/human-review/' + num, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: checked })
    });
  } catch(e) { /* best effort */ }
}

function checkCollapse(num) {
  var aiCb = document.getElementById('cb-ai-' + num);
  var humanCb = document.getElementById('cb-human-' + num);
  var card = document.getElementById('pr-' + num);
  var expandBtn = document.getElementById('expand-btn-' + num);
  var collapsedChecks = document.getElementById('collapsed-checks-' + num);
  var cherryBtn = document.getElementById('btn-cherry-' + num);
  var bothChecked = aiCb && aiCb.checked && humanCb && humanCb.checked;

  if (bothChecked) {
    card.classList.add('collapsed');
    expandBtn.style.display = '';
    expandBtn.innerHTML = '&#9654;';
    collapsedChecks.innerHTML = '<span class="collapsed-check ai">AI \\u2713</span><span class="collapsed-check human">Human \\u2713</span>';
    if (cherryBtn && !cherryBtn.classList.contains('done')) cherryBtn.style.display = '';
  } else {
    card.classList.remove('collapsed');
    expandBtn.style.display = 'none';
    collapsedChecks.innerHTML = '';
    if (cherryBtn && !cherryBtn.classList.contains('done')) cherryBtn.style.display = 'none';
  }
}

function toggleCollapse(num) {
  var card = document.getElementById('pr-' + num);
  var expandBtn = document.getElementById('expand-btn-' + num);
  if (card.classList.contains('collapsed')) {
    card.classList.remove('collapsed');
    expandBtn.innerHTML = '&#9660;';
  } else {
    card.classList.add('collapsed');
    expandBtn.innerHTML = '&#9654;';
  }
}

async function loadFiles(num) {
  var section = document.getElementById('files-section-' + num);
  try {
    var res = await fetch('/api/files/' + num);
    if (!res.ok) throw new Error('Failed');
    var files = await res.json();
    var reviewFiles = files.kept || [];
    var skippedFiles = files.skipped || [];
    section.innerHTML =
      '<div class="file-group"><div class="file-group-label">Files to review (' + reviewFiles.length + ')</div>'
      + '<ul class="file-list" id="review-files-' + num + '" style="display:none">'
      + reviewFiles.map(function(f) { return '<li>' + esc(f) + '</li>'; }).join('')
      + '</ul>'
      + (reviewFiles.length ? '<button class="file-toggle" onclick="toggleFiles(\\'review-files-' + num + '\\', this)">Show files</button>' : '')
      + '</div>'
      + '<div class="file-group"><div class="file-group-label">Skipped (' + skippedFiles.length + ')</div>'
      + '<ul class="file-list" id="skipped-files-' + num + '" style="display:none">'
      + skippedFiles.map(function(f) { return '<li class="skipped">' + esc(f) + '</li>'; }).join('')
      + '</ul>'
      + (skippedFiles.length ? '<button class="file-toggle" onclick="toggleFiles(\\'skipped-files-' + num + '\\', this)">Show files</button>' : '')
      + '</div>';
  } catch(e) {
    section.innerHTML = '<span style="font-size:11px;color:#f87171">Failed to load files</span>';
  }
}

function toggleFiles(id, btn) {
  var el = document.getElementById(id);
  if (el.style.display === 'none') { el.style.display = 'block'; btn.textContent = 'Hide files'; }
  else { el.style.display = 'none'; btn.textContent = 'Show files'; }
}

var providerNames = { claude: 'Claude', gemini: 'Gemini', gpt: 'GPT' };

async function reviewPR(num, provider) {
  provider = provider || 'claude';
  var btn = document.getElementById('btn-' + provider + '-' + num);
  var resultDiv = document.getElementById('result-' + num);
  // Disable all 3 buttons while reviewing
  ['claude','gemini','gpt'].forEach(function(p) {
    var b = document.getElementById('btn-' + p + '-' + num);
    if (b) { b.disabled = true; b.classList.add('reviewing'); }
  });
  btn.textContent = 'Reviewing...';
  resultDiv.innerHTML = '<div class="review-summary"><span class="spinner"></span> Sending to ' + providerNames[provider] + ' for review...</div>';

  try {
    var res = await fetch('/api/review/' + num + '?provider=' + provider);
    if (!res.ok) {
      var errText = await res.text();
      throw new Error(errText || 'Review failed');
    }
    var data = await res.json();
    await renderReview(num, data);
    setAIChecked(num, true);
    checkCollapse(num);
  } catch(e) {
    resultDiv.innerHTML = '<div class="error-msg">' + providerNames[provider] + ' review failed: ' + esc(e.message) + '</div>';
  } finally {
    // Re-enable all buttons
    ['claude','gemini','gpt'].forEach(function(p) {
      var b = document.getElementById('btn-' + p + '-' + num);
      if (b) { b.disabled = false; b.classList.remove('reviewing'); b.textContent = providerNames[p]; }
    });
  }
}

var reviewCounter = 0;

async function renderReview(num, data) {
  var resultDiv = document.getElementById('result-' + num);
  var provider = data.provider || 'ai';
  var blockId = 'review-block-' + num + '-' + provider + '-' + (++reviewCounter);

  // Remove previous block from same provider if exists
  var prev = document.getElementById('review-block-' + num + '-' + provider);
  if (prev) prev.remove();

  var issues = data.issues || [];
  var hasCritical = issues.some(function(i) { return i.severity === 'critical'; });
  var badgeClass = issues.length === 0 ? 'badge-clean' : hasCritical ? 'badge-critical' : 'badge-issues';
  var badgeText = issues.length === 0 ? '\\u2713 Clean' : issues.length + ' issue' + (issues.length > 1 ? 's' : '');
  var riskColor = data.risk_score >= 7 ? '#f87171' : data.risk_score >= 4 ? '#facc15' : '#4ade80';
  var reviewedAt = data.reviewed_at ? new Date(data.reviewed_at).toLocaleString() : '';
  var providerLabel = (providerNames[provider] || 'AI') + ' Review';

  var html = '<div class="review-block" id="review-block-' + num + '-' + provider + '">'
    + '<div class="review-summary" onclick="toggleReviewBlock(\\'' + blockId + '-details\\')" style="cursor:pointer;user-select:none">'
    + '<span class="review-toggle" id="' + blockId + '-arrow">&#9660;</span> '
    + '<strong>' + esc(providerLabel) + '</strong>'
    + '<span class="review-badge ' + badgeClass + '">' + badgeText + '</span>'
    + (data.risk_score != null ? '<span class="risk-score" style="color:' + riskColor + '">Risk ' + data.risk_score + '/10</span>' : '')
    + (reviewedAt ? '<span style="font-size:11px;color:#475569;margin-left:10px">' + esc(reviewedAt) + '</span>' : '')
    + '<br><span style="margin-top:6px;display:inline-block">' + esc(data.summary || '') + '</span>'
    + '</div>';

  html += '<div class="review-details" id="' + blockId + '-details">';
  if (issues.length === 0) {
    html += '<div style="padding:16px 0;text-align:center;color:#4ade80;font-size:14px">No medium+ severity issues found</div>';
  } else {
    for (var idx = 0; idx < issues.length; idx++) {
      var issue = issues[idx];
      var sev = issue.severity || 'medium';
      var fileRef = (issue.file || '') + ':' + (issue.line || '');
      var lineNum = String(issue.line || '').replace(/[^0-9]/g, '');
      var fileHash = await sha256(issue.file || '');
      var fileUrl = GITHUB_PR + num + '/files#diff-' + fileHash + (lineNum ? 'R' + lineNum : '');
      html += '<div class="issue-card ' + sev + '">'
        + '<div class="issue-header">'
        + '<span class="issue-severity ' + sev + '">' + sev.toUpperCase() + '</span>'
        + '<span class="issue-category">' + esc(issue.category || '') + '</span>'
        + '<a class="issue-file" href="' + fileUrl + '" target="_blank">' + esc(fileRef) + '</a>'
        + '</div>'
        + '<div class="issue-title">' + esc(issue.title || '') + '</div>'
        + '<div class="issue-desc">' + esc(issue.description || '') + '</div>'
        + (issue.suggestion ? '<div class="issue-fix"><div class="issue-fix-label">Suggested Fix</div><pre>' + esc(issue.suggestion) + '</pre></div>' : '')
        + '</div>';
    }
  }
  html += '</div></div>';

  resultDiv.insertAdjacentHTML('beforeend', html);
}

function toggleReviewBlock(detailsId) {
  var el = document.getElementById(detailsId);
  var arrow = document.getElementById(detailsId.replace('-details', '-arrow'));
  if (!el) return;
  if (el.style.display === 'none') {
    el.style.display = 'block';
    if (arrow) arrow.innerHTML = '&#9660;';
  } else {
    el.style.display = 'none';
    if (arrow) arrow.innerHTML = '&#9654;';
  }
}

async function cherryPick(num) {
  var btn = document.getElementById('btn-cherry-' + num);
  var resultDiv = document.getElementById('cherry-result-' + num);
  if (!confirm('Cherry-pick PR #' + num + ' to ' + targetBranch + '?\\n\\nMake sure the PR is squash-merged first.')) return;
  btn.disabled = true;
  btn.textContent = 'Cherry-picking...';
  resultDiv.innerHTML = '<div class="cherry-result" style="color:#64748b"><span class="spinner" style="width:12px;height:12px;border-width:1.5px"></span> Cherry-picking to ' + esc(targetBranch) + '...</div>';

  try {
    var res = await fetch('/api/cherry-pick/' + num, { method: 'POST' });
    if (!res.ok) {
      var errText = await res.text();
      throw new Error(errText || 'Cherry-pick failed');
    }
    var data = await res.json();
    btn.textContent = 'Cherry-picked';
    btn.classList.add('done');
    btn.disabled = true;
    resultDiv.innerHTML = '<div class="cherry-result success">Cherry-picked to ' + esc(targetBranch) + ' (' + data.sha.substring(0, 7) + ')</div>';
  } catch(e) {
    btn.disabled = false;
    btn.textContent = 'Retry cherry-pick';
    resultDiv.innerHTML = '<div class="cherry-result error">Cherry-pick failed: ' + esc(e.message) + '</div>';
  }
}
</script>
</body>
</html>`;
}

// HTTP Server
var server = http.createServer(async function(req, res) {
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(getHTML());
    } else if (req.method === "GET" && req.url === "/api/prs") {
      var prs = await listPRs();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(prs));
    } else if (req.method === "GET" && req.url === "/api/merged-prs") {
      var prs = await listMergedPRs();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(prs));
    } else if (req.method === "GET" && req.url.startsWith("/api/files/")) {
      var prNum = parseInt(req.url.split("/").pop());
      if (isNaN(prNum)) { res.writeHead(400); res.end("Invalid PR number"); return; }
      var files = await getFiles(prNum);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(files));
    } else if (req.method === "GET" && req.url.startsWith("/api/cached-review/")) {
      var prNum = parseInt(req.url.split("/").pop());
      if (isNaN(prNum)) { res.writeHead(400); res.end("Invalid PR number"); return; }
      var cached = getCachedReview(prNum);
      if (!cached) { res.writeHead(404); res.end("No cached review"); return; }
      var result = cached.result || {};
      result.reviewed_at = cached.reviewed_at;
      result.human_reviewed = !!cached.human_reviewed;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } else if (req.method === "POST" && req.url.startsWith("/api/human-review/")) {
      var prNum = parseInt(req.url.split("/").pop());
      if (isNaN(prNum)) { res.writeHead(400); res.end("Invalid PR number"); return; }
      var body = "";
      req.on("data", function(c) { body += c; });
      await new Promise(function(resolve) { req.on("end", resolve); });
      var parsed = JSON.parse(body);
      setHumanReviewed(prNum, parsed.value);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === "GET" && req.url.startsWith("/api/review/")) {
      var urlParts = req.url.split("?");
      var prNum = parseInt(urlParts[0].split("/").pop());
      var params = new URLSearchParams(urlParts[1] || "");
      var provider = params.get("provider") || "claude";
      if (isNaN(prNum)) { res.writeHead(400); res.end("Invalid PR number"); return; }
      var result = await reviewPR(prNum, provider);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } else if (req.method === "GET" && req.url === "/api/target-branch") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ branch: CHERRY_PICK_TARGET }));
    } else if (req.method === "POST" && req.url.startsWith("/api/cherry-pick/")) {
      var prNum = parseInt(req.url.split("/").pop());
      if (isNaN(prNum)) { res.writeHead(400); res.end("Invalid PR number"); return; }
      var result = await cherryPickPR(prNum, CHERRY_PICK_TARGET);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  } catch(e) {
    console.error("Error:", e.message);
    res.writeHead(500);
    res.end(e.message);
  }
});

server.listen(PORT, function() {
  console.log("PR Review Dashboard running at http://localhost:" + PORT);
  console.log("Repo: " + REPO);
  console.log("Press Ctrl+C to stop.\n");
});
