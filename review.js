var fetch = require("node-fetch");
var fs = require("fs");
var path = require("path");

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

if (!TOKEN || !AI_KEY) { console.error("Missing GITHUB_TOKEN or ANTHROPIC_API_KEY in .env"); process.exit(1); }

// File filter — customize these arrays to change what gets excluded
var SKIP_EXT = [".json", ".lock", ".snap", ".map", ".min.js", ".min.css"];
var SKIP_PATTERN = [".spec.ts", ".spec.js", ".test.ts", ".test.js", ".test.tsx", ".test.jsx", ".stories.tsx", ".stories.ts"];

function skipFile(name) {
  if (SKIP_EXT.some(function(e) { return name.endsWith(e); })) return true;
  if (SKIP_PATTERN.some(function(p) { return name.endsWith(p); })) return true;
  if (name.includes("__tests__") || name.includes("__mocks__") || name.includes("__snapshots__")) return true;
  return false;
}

// GitHub helpers
async function gh(ep, accept) {
  var r = await fetch("https://api.github.com/repos/" + REPO + ep, {
    headers: { Authorization: "token " + TOKEN, Accept: accept || "application/vnd.github.v3+json" }
  });
  if (!r.ok) throw new Error("GitHub " + r.status + " " + r.statusText);
  return accept ? r.text() : r.json();
}

async function getFiles(prNum) {
  var all = await gh("/pulls/" + prNum + "/files?per_page=100");
  var kept = all.filter(function(f) { return !skipFile(f.filename); });
  return { total: all.length, kept: kept, skipped: all.length - kept.length };
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

// Claude review
async function reviewPR(pr) {
  var files = await getFiles(pr.number);
  console.log("   Files: " + files.kept.length + " to review, " + files.skipped + " skipped");
  console.log("   Kept:  " + files.kept.map(function(f) { return f.filename.split("/").pop(); }).join(", "));
  console.log("   Fetching diff...");
  var rawDiff = await gh("/pulls/" + pr.number, "application/vnd.github.v3.diff");
  var diff = filterDiff(rawDiff);
  console.log("   Diff size: " + diff.length + " chars (after filtering)");

  if (diff.trim().length < 10) {
    console.log("   No reviewable code changes after filtering.\n");
    return { pr: pr, files: files, summary: "No reviewable changes", issues: [], risk: 0 };
  }

  console.log("   Sending to Claude...");
  var r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": AI_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 4000,
      messages: [{ role: "user", content:
        "You are a senior code reviewer. Analyze this PR diff for ONLY medium, high, or critical severity bugs and security issues.\n\n"
        + "Do NOT report: style issues, formatting, naming, low-severity items, test files, or json changes.\n\n"
        + "Respond ONLY with valid JSON (no markdown, no backticks):\n"
        + '{"summary":"Brief assessment","issues":[{"severity":"medium|high|critical","category":"bug|security","file":"filename","line":"line","title":"title","description":"explanation","suggestion":"code fix"}],"risk_score":1}\n\n'
        + "PR: " + pr.title + " (#" + pr.number + ")\n"
        + "Branch: " + pr.head.ref + " -> " + pr.base.ref + "\n"
        + "Author: " + pr.user.login + "\n\nDIFF:\n" + diff
      }]
    })
  });
  if (!r.ok) throw new Error("Claude API " + r.status);
  var d = await r.json();
  var txt = d.content.map(function(c) { return c.text || ""; }).join("");
  return {
    pr: pr, files: files,
    summary: JSON.parse(txt.replace(/```json|```/g, "").trim()).summary,
    issues: JSON.parse(txt.replace(/```json|```/g, "").trim()).issues || [],
    risk: JSON.parse(txt.replace(/```json|```/g, "").trim()).risk_score
  };
}

// HTML report builder
function esc(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function saveReport(results) {
  var sC={critical:"#ef4444",high:"#f97316",medium:"#eab308"};
  var sB={critical:"rgba(239,68,68,.08)",high:"rgba(249,115,22,.08)",medium:"rgba(234,179,8,.08)"};
  var tot=0,cr=0;
  results.forEach(function(r){(r.issues||[]).forEach(function(i){tot++;if(i.severity==="critical")cr++})});

  var cards=results.map(function(r){
    var n=r.issues.length;
    var hc=r.issues.some(function(i){return i.severity==="critical"});
    var bSt=n===0?"background:rgba(74,222,128,.12);color:#4ade80":hc?"background:rgba(248,113,113,.12);color:#f87171":"background:rgba(250,204,21,.12);color:#facc15";
    var bTx=n===0?"\u2713 Clean":n+" issue"+(n>1?"s":"");
    var iss=r.issues.map(function(i){
      return '<div style="padding:12px;margin:8px 16px;border-radius:8px;border-left:3px solid '+sC[i.severity]+';background:'+sB[i.severity]+'">'
        +'<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px"><span style="font-size:10px;font-weight:700;color:'+sC[i.severity]+'">'+i.severity.toUpperCase()+'</span><span style="font-size:11px;color:#64748b">'+i.category+'</span><span style="margin-left:auto;font-size:11px;color:#475569;font-family:monospace">'+esc(i.file)+':'+i.line+'</span></div>'
        +'<div style="font-size:13px;font-weight:600;margin-bottom:3px">'+esc(i.title)+'</div>'
        +'<div style="font-size:12px;color:#94a3b8;line-height:1.5">'+esc(i.description)+'</div>'
        +(i.suggestion?'<div style="margin-top:8px;padding:8px;background:#08080d;border:1px solid #1e1e2e;border-radius:6px"><div style="font-size:10px;color:#64748b;font-weight:600;margin-bottom:3px">Fix</div><pre style="font-size:12px;color:#86efac;white-space:pre-wrap;margin:0">'+esc(i.suggestion)+'</pre></div>':'')
        +'</div>'
    }).join("");
    return '<div style="background:#111118;border:1px solid #1e1e2e;border-radius:12px;margin-bottom:10px;overflow:hidden">'
      +'<div style="padding:14px 16px"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
      +'<span style="color:#4ade80;font-weight:700">PR</span>'
      +'<span style="font-weight:600;font-size:14px">'+esc(r.pr.title)+'</span>'
      +'<span style="font-size:11px;color:#475569">#'+r.pr.number+'</span>'
      +'<span style="font-size:11px;padding:3px 10px;border-radius:99px;font-weight:600;'+bSt+'">'+bTx+'</span>'
      +(r.risk!=null?'<span style="font-size:11px;font-family:monospace;font-weight:700;color:'+(r.risk>=7?'#f87171':r.risk>=4?'#facc15':'#4ade80')+'">Risk '+r.risk+'/10</span>':'')
      +'</div>'
      +'<div style="font-size:11px;color:#475569;margin-top:3px">'+esc(r.pr.head.ref)+' > '+esc(r.pr.base.ref)+' | '+r.pr.user.login+' | '+r.files.kept.length+' files ('+r.files.skipped+' filtered) | <a href="'+r.pr.html_url+'" target="_blank" style="color:#818cf8">GitHub</a></div></div>'
      +(r.summary?'<div style="padding:0 16px 10px;font-size:13px;color:#94a3b8">'+esc(r.summary)+'</div>':'')
      +(n===0?'<div style="padding:20px;text-align:center;color:#4ade80;font-size:14px">No medium+ issues</div>':'')
      +iss+'</div>'
  }).join("");

  var html='<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#08080d;color:#e2e8f0;font-family:-apple-system,sans-serif;padding:24px}code{font-size:11px;color:#64748b}</style></head><body><div style="max-width:960px;margin:0 auto">'
    +'<h1 style="font-size:22px;margin-bottom:2px">PR Review Report</h1><p style="font-size:12px;color:#64748b;margin-bottom:20px">'+esc(REPO)+' | '+new Date().toLocaleString()+'</p>'
    +'<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px">'
    +'<div style="padding:14px;background:#111118;border:1px solid #1e1e2e;border-radius:12px;text-align:center"><div style="font-size:26px;font-weight:700;color:#60a5fa">'+results.length+'</div><div style="font-size:11px;color:#64748b">PRs</div></div>'
    +'<div style="padding:14px;background:#111118;border:1px solid #1e1e2e;border-radius:12px;text-align:center"><div style="font-size:26px;font-weight:700;color:#4ade80">'+results.filter(function(r){return r.issues}).length+'</div><div style="font-size:11px;color:#64748b">Reviewed</div></div>'
    +'<div style="padding:14px;background:#111118;border:1px solid #1e1e2e;border-radius:12px;text-align:center"><div style="font-size:26px;font-weight:700;color:#facc15">'+tot+'</div><div style="font-size:11px;color:#64748b">Issues</div></div>'
    +'<div style="padding:14px;background:#111118;border:1px solid #1e1e2e;border-radius:12px;text-align:center"><div style="font-size:26px;font-weight:700;color:#f87171">'+cr+'</div><div style="font-size:11px;color:#64748b">Critical</div></div>'
    +'</div>'+cards+'</div></body></html>';

  var outFile=path.join(__dirname,"pr-review-report.html");
  fs.writeFileSync(outFile,html,"utf8");
  return outFile;
}

// Main
async function main() {
  var arg = process.argv[2];
  if (!arg) {
    console.log("\nOpen PRs in " + REPO + ":\n");
    var prs = await gh("/pulls?state=open&per_page=30");
    if (!prs.length) { console.log("  No open PRs.\n"); return; }
    for (var i = 0; i < prs.length; i++) {
      var pr = prs[i];
      var files = await getFiles(pr.number);
      var ticket = (pr.head.ref + " " + pr.title).match(/([A-Z][A-Z0-9]+-\d+)/);
      console.log("  #" + pr.number + "  " + pr.title + (ticket ? " [" + ticket[1] + "]" : ""));
      console.log("       " + files.kept.length + " files to review, " + files.skipped + " skipped | " + pr.user.login + " | " + pr.head.ref);
    }
    console.log("\n  Review one: node review.js <number>");
    console.log("  Review all: node review.js all\n");
    return;
  }
  var prs = await gh("/pulls?state=open&per_page=30");
  var toReview = [];
  if (arg === "all") { toReview = prs; }
  else {
    var num = parseInt(arg);
    var found = prs.find(function(p) { return p.number === num; });
    if (!found) { console.error("PR #" + arg + " not found or not open."); process.exit(1); }
    toReview = [found];
  }
  var results = [];
  for (var i = 0; i < toReview.length; i++) {
    var pr = toReview[i];
    console.log("\n-- PR #" + pr.number + ": " + pr.title);
    try {
      var result = await reviewPR(pr);
      console.log("   Done: " + result.issues.length + " issue(s), risk " + result.risk + "/10\n");
      results.push(result);
    } catch(e) {
      console.log("   Error: " + e.message + "\n");
      results.push({ pr:pr, files:{kept:[],skipped:0}, summary:"Failed", issues:[], error:e.message });
    }
  }
  var outFile = saveReport(results);
  console.log("Report saved: " + outFile);
  console.log("Open it in your browser!\n");
}

main().catch(function(e) { console.error(e.message); process.exit(1); });