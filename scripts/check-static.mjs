import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { HUMAN_TEST_SOURCE_FILES } from "./build-human-test-package.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionRoot = resolve(projectRoot, "extension");
const requiredFiles = [...HUMAN_TEST_SOURCE_FILES];
const requiredSet = new Set(requiredFiles);
const textExtensions = new Set([".css", ".html", ".js", ".json", ".md", ".mjs", ".sql"]);
const excludedPrefixes = [
  ".codex-remote-attachments/",
  ".git/",
  ".worktrees/",
  "app/",
  "doa2ai-site/",
  "dogfood/",
  "node_modules/",
  "preview/",
  "review-bundles/",
  "runtime/",
  "tests/",
];

function fail(message) {
  console.error(`Static check failed: ${message}`);
  process.exitCode = 1;
}

function projectRelative(path) {
  return relative(projectRoot, path).split(sep).join("/");
}

function within(root, target) {
  const fromRoot = relative(root, target);
  return !fromRoot || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function localTarget(sourceFile, reference) {
  const clean = reference.trim().replace(/^<|>$/g, "").split(/[?#]/, 1)[0];
  if (!clean || clean.startsWith("#") || clean.startsWith("data:") || clean.startsWith("mailto:")) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(clean)) return null;
  if (clean.startsWith("/")) return resolve(projectRoot, clean.replace(/^\/+/, ""));
  return resolve(dirname(sourceFile), clean);
}

function checkReference(sourceFile, reference, kind, allowedRoot = projectRoot) {
  if (isAbsolute(reference) && !reference.startsWith("/")) {
    fail(`${kind} reference must not use an absolute filesystem path: ${reference}`);
    return true;
  }
  const target = localTarget(sourceFile, reference);
  if (!target) return false;
  if (!within(allowedRoot, target)) {
    fail(`${kind} reference escapes the product package boundary: ${reference}`);
    return true;
  }
  const targetRelative = projectRelative(target);
  if (!requiredSet.has(targetRelative)) {
    fail(`${kind} reference enters a non-product or unpackaged path: ${targetRelative}`);
    return true;
  }
  if (!existsSync(target) || !statSync(target).isFile()) fail(`${kind} reference is missing: ${reference}`);
  return true;
}

export function moduleReferences(moduleSource) {
  const references = [];
  const patterns = [
    /\bfrom[ \t\r\n]+["']([^"']+)["']/g,
    /\bimport[ \t\r\n]+["']([^"']+)["']/g,
    /\bimport[ \t\r\n]*\([ \t\r\n]*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of moduleSource.matchAll(pattern)) references.push(match[1]);
  }
  return references;
}

export function runStaticChecks() {
  if (requiredFiles.length !== requiredSet.size || JSON.stringify(requiredFiles) !== JSON.stringify([...requiredFiles].sort())) {
    fail("the product package allowlist must be unique and sorted");
  }
  for (const relativePath of requiredFiles) {
    if (relativePath.includes("\\") || relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
      fail(`unsafe required path: ${relativePath}`);
    }
    for (const prefix of excludedPrefixes) {
      if (relativePath.startsWith(prefix)) fail(`product package includes excluded surface ${relativePath}`);
    }
    const path = resolve(projectRoot, ...relativePath.split("/"));
    if (!within(projectRoot, path) || !existsSync(path) || !statSync(path).isFile()) {
      fail(`required product file is missing: ${relativePath}`);
    }
  }

  const textSourcePaths = requiredFiles
    .filter((path) => textExtensions.has(extname(path).toLowerCase()))
    .map((path) => resolve(projectRoot, ...path.split("/")))
    .filter((path) => existsSync(path) && statSync(path).isFile());

  let referenceCount = 0;
  for (const htmlPath of textSourcePaths.filter((path) => extname(path).toLowerCase() === ".html")) {
    const html = readFileSync(htmlPath, "utf8");
    for (const match of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
      if (checkReference(htmlPath, match[1], "HTML asset", extensionRoot)) referenceCount += 1;
    }
  }

  for (const cssPath of textSourcePaths.filter((path) => extname(path).toLowerCase() === ".css")) {
    const css = readFileSync(cssPath, "utf8");
    for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
      if (checkReference(cssPath, match[1], "CSS asset", extensionRoot)) referenceCount += 1;
    }
  }

  for (const modulePath of textSourcePaths.filter((path) => [".js", ".mjs"].includes(extname(path).toLowerCase()))) {
    const moduleSource = readFileSync(modulePath, "utf8");
    for (const reference of moduleReferences(moduleSource)) {
      if (reference.startsWith("node:")) continue;
      if (checkReference(modulePath, reference, "module import")) referenceCount += 1;
    }
  }

  for (const markdownPath of textSourcePaths.filter((path) => extname(path).toLowerCase() === ".md")) {
    const markdown = readFileSync(markdownPath, "utf8");
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (checkReference(markdownPath, match[1], "Markdown link")) referenceCount += 1;
    }
  }

  if (!process.exitCode) {
    console.log(
      `Static checks passed: ${requiredFiles.length} product files, ${referenceCount} closed local references, no packaged demo/test/runtime surfaces.`,
    );
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runStaticChecks();
