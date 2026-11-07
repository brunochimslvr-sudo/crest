// Checks translations: every t("…") string needs an entry in src/i18n/en.json, and German
// text outside of t() is flagged; the other dictionaries are counted per language.
// `npm run i18n` (--fix adds missing entries as "TODO" and sorts alphabetically; nothing is deleted).
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const dictPath = join(root, "i18n", "en.json");
const dict = JSON.parse(readFileSync(dictPath, "utf8"));
const fix = process.argv.includes("--fix");

const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|ts)$/.test(f)) files.push(p);
  }
};
walk(root);

const used = new Set();
const suspicious = [];
// t("…"), t('…'), t(`…`).
const callRe = /\bt\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;
const germanRe = /["'`]([^"'`\n]*(?:[äöüÄÖÜß]|\b(?:und|oder|nicht|keine?|Einstellungen|Datei|Dateien|Woche|Heute|Ziehen|Öffnen|Schließen|Löschen)\b)[^"'`\n]*)["'`]/g;

for (const file of files) {
  if (file.includes(`${join("i18n", "")}`) || file.includes(`${join("dev", "")}`)) continue;
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(callRe)) used.add(m[2].replace(/\\(["'`\\])/g, "$1"));
  // A regex on "ß" and the test fixtures are not interface text.
  if (/\.test\.tsx?$/.test(file) || file.endsWith(join("settings", "search.ts"))) continue;
  text.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").trim();
    if (code.startsWith("*") || code.startsWith("/*")) return;
    for (const m of code.matchAll(germanRe)) {
      const s = m[1];
      if (dict[s] !== undefined || used.has(s)) continue;
      if (/^[\w.:/-]+$/.test(s) && !/[äöüß]/.test(s)) continue;
      suspicious.push(`${file.slice(root.length)}:${i + 1}  ${s}`);
    }
  });
}

const missing = [...used].filter((k) => dict[k] === undefined).sort();
const unused = Object.keys(dict).filter((k) => !used.has(k)).sort();

console.log(`Missing in en.json (${missing.length}):\n  ${missing.join("\n  ")}`);
console.log(`\nGerman without t() (${suspicious.length}):\n  ${suspicious.join("\n  ")}`);
// Usually used indirectly (label lists that only go through t() at render time).
if (process.argv.includes("--unused")) console.log(`\nNot found via t() directly (${unused.length}):\n  ${unused.join("\n  ")}`);

// The other languages: keys of en.json they lack (they fall back to English) and keys en.json no longer has.
// Any gap fails the check; German is the ids, de.json only holds corrections.
// A translation must keep the {placeholders} of the English text.
const holes = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join();
let broken = 0;
console.log("\nOther languages (missing / not in en.json / wrong placeholders):");
for (const f of readdirSync(join(root, "i18n")).filter((f) => f.endsWith(".json") && f !== "en.json").sort()) {
  const other = JSON.parse(readFileSync(join(root, "i18n", f), "utf8"));
  const lacking = f === "de.json" ? [] : Object.keys(dict).filter((k) => !other[k]);
  const stale = Object.keys(other).filter((k) => dict[k] === undefined);
  const wrong = f === "de.json" ? [] : Object.keys(other).filter((k) => dict[k] !== undefined && other[k] && holes(other[k]) !== holes(dict[k]));
  broken += lacking.length + stale.length + wrong.length;
  console.log(`  ${f.replace(".json", "").padEnd(6)} ${String(lacking.length).padStart(5)} / ${stale.length} / ${wrong.length}`);
}

if (fix) {
  const next = {};
  for (const k of [...Object.keys(dict), ...missing].sort((a, b) => a.localeCompare(b, "de")))
    next[k] = dict[k] ?? "TODO";
  writeFileSync(dictPath, JSON.stringify(next, null, 1) + "\n");
  console.log("\nen.json updated.");
}
process.exitCode = missing.length > 0 || broken > 0 ? 1 : 0;
