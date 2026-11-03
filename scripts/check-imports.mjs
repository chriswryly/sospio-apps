import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFiles } from "./release-scan.mjs";

const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(resolve(root, "local/package.json"));
const ts = require("typescript");
const errors = [];
let checked = 0;

function contained(path) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

for (const file of sourceFiles(root)) {
  if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
  const configPath = ts.findConfigFile(dirname(file), ts.sys.fileExists);
  const config = configPath && contained(configPath) ? ts.readConfigFile(configPath, ts.sys.readFile).config : {};
  const options = ts.parseJsonConfigFileContent(config, ts.sys, configPath ? dirname(configPath) : root).options;
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  function inspect(node) {
    let literal;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isIdentifier(node.expression) && node.expression.text === "require")) literal = node.arguments[0];
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal = node.argument.literal;
    if (literal && ts.isStringLiteralLike(literal)) {
      const name = literal.text;
      const resolved = ts.resolveModuleName(name, file, options, ts.sys).resolvedModule;
      checked++;
      if (resolved && !resolved.isExternalLibraryImport && !contained(realpathSync(resolved.resolvedFileName))) {
        errors.push(`${relative(root, file)}: external source ${name}`);
      } else if (!resolved && (name.startsWith(".") || isAbsolute(name))) {
        const asset = resolve(dirname(file), name);
        if (!contained(asset) || !existsSync(asset)) errors.push(`${relative(root, file)}: unresolved source ${name}`);
      } else if (!resolved && name === "@sospio/cockpit") {
        errors.push(`${relative(root, file)}: unresolved shared package ${name}`);
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);
}

if (errors.length) {
  process.stderr.write(errors.join("\n") + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${checked} source imports; all remain inside the release tree.\n`);
}
