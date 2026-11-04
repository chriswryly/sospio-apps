import { readdirSync, readFileSync, lstatSync, realpathSync } from "node:fs";
import { resolve, relative, join } from "node:path";

const excluded = new Set(["node_modules", "out", "dist", ".cache", ".git"]);
const prohibited = /[j]ev|[l]una|[t]ypesafe|[q]wen|[s]idecar|judge[_]ladder|hybrid_[a-z0-9_]*schema|[j]udge_request_count|[c]osmos|W[P]-F|r[s]h[\\/]/i;
const internalRecord = /(?!README[.]md\b)[A-Z0-9_]{6,}[.]md\b/;
const credentials = /s[k]-|Bear[e]r |[a-f0-9]{32,}/i;
const publicIdentifiers = /\b[j]udge[_]ladder(?:_verdict_v1)?\b/g;
// Chris chose (2026-11-03) to name the principal backend in the top-level README's data disclosure. Only that
// file, and only the capitalised name as a whole word, is allowed; code, tests and app READMEs stay strict.
const disclosedBackend = /\b[J]ev\b/g;

export function sourceFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory)) {
      if (excluded.has(entry)) continue;
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Source links are not allowed: ${relative(root, path)}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(path);
    }
  }
  visit(root);
  return files.sort();
}

export function scanText(body, fileName = "source.ts") {
  let text = body;
  if (fileName.endsWith("package-lock.json")) {
    const lock = JSON.parse(text);
    function stripIntegrity(value) {
      if (!value || typeof value !== "object") return;
      for (const key of Object.keys(value)) {
        if (key === "integrity") delete value[key];
        else stripIntegrity(value[key]);
      }
    }
    stripIntegrity(lock);
    text = JSON.stringify(lock);
  }
  let names = text.replace(publicIdentifiers, "public_wire_identifier");
  if (fileName === "README.md") names = names.replace(disclosedBackend, "disclosed_backend");
  const credentialText = fileName === ".github/workflows/release.yml" ? text.replace(
    /^(\s*-\s+uses:\s+actions\/(?:checkout|setup-node|upload-artifact|download-artifact)@)[a-f0-9]{40}(?=\s*(?:#.*)?$)/gm,
    "$1public_action_pin") : text;
  return [prohibited.test(names) ? "private monitor term" : undefined,
    internalRecord.test(names) ? "internal record name" : undefined,
    credentials.test(credentialText) ? "credential-shaped value" : undefined].filter(Boolean);
}

export function scanRelease(root) {
  const realRoot = realpathSync(resolve(root));
  return sourceFiles(realRoot).flatMap(path => {
    const name = relative(realRoot, path);
    return [...scanText(name), ...scanText(readFileSync(path, "utf8"), name)]
      .map(reason => `${name}: ${reason}`);
  });
}
