import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const HUMAN_TEST_SOURCE_FILES = Object.freeze([
  "LICENSE",
  "PRODUCT_CHARTER.md",
  "PROJECT_PROVENANCE.md",
  "docs/ARCHITECTURE.md",
  "docs/LAUNCHABLE_GUI_UI_TRACK.md",
  "docs/REMOTE_JUDGE_RUNBOOK.md",
  "extension/README.md",
  "extension/action-model.js",
  "extension/activity.html",
  "extension/activity.js",
  "extension/background.js",
  "extension/broker-client.js",
  "extension/device-identity.js",
  "extension/local-store.js",
  "extension/manifest.json",
  "extension/mark.svg",
  "extension/page-bridge.js",
  "extension/policy.js",
  "extension/popup.css",
  "extension/popup.html",
  "extension/popup.js",
  "extension/protected-tools.js",
  "extension/protocol.js",
  "extension/receipt.html",
  "extension/receipt.js",
  "extension/review.css",
  "extension/review.html",
  "extension/review.js",
  "extension/rules.html",
  "extension/rules.js",
  "extension/setup.css",
  "extension/setup.html",
  "extension/setup.js",
  "extension/task-manager.js",
  "extension/tasks.html",
  "extension/tasks.js",
  "extension/v2-client.js",
  "extension/view-model.js",
  "scripts/build-human-test-package.mjs",
  "scripts/check-extension.mjs",
  "scripts/check-static.mjs",
  "service/README.md",
  "service/migrations/0001_initial.sql",
  "service/migrations/0002_reconcile_claimed_preview.sql",
  "service/migrations/0003_bound_grants_and_execution_snapshots.sql",
  "service/migrations/0004_local_authority_v2.sql",
  "service/schema.sql",
  "service/src/worker.js",
  "service/wrangler.jsonc",
]);

export const HUMAN_TEST_GENERATED_FILES = Object.freeze([
  "HUMAN_TEST_MANIFEST.json",
  "PACKAGE_README.md",
  "SHA256SUMS",
]);

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestName = "HUMAN_TEST_MANIFEST.json";
const sumsName = "SHA256SUMS";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(repoRoot, args, options = {}) {
  const environment = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
  ]) {
    delete environment[name];
  }
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: options.binary ? null : "utf8",
    env: environment,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function normalizeSourceRevision(source) {
  if (typeof source !== "string" || !source.trim()) throw new Error("A non-empty source revision is required.");
  const value = source.trim();
  if (value.startsWith("-") || /[\0\r\n]/.test(value)) throw new Error("The source revision is invalid.");
  return value;
}

function safeBundlePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
    isAbsolute(value)
  ) {
    throw new Error(`Unsafe bundle path: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertInside(root, target) {
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot === "." || fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw new Error(`Bundle path does not resolve below the package root: ${target}`);
  }
}

function resolvesWithin(root, target) {
  const fromRoot = relative(root, target);
  return !fromRoot || fromRoot === "." || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function projectPhysicalPath(target) {
  let existing = resolve(target);
  const missingSegments = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`Could not resolve an existing ancestor for output path: ${target}`);
    missingSegments.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync.native(existing), ...missingSegments);
}

function assertOutsideGitDirectories(destination, gitDirectories) {
  const physicalDestination = projectPhysicalPath(destination);
  for (const gitDirectory of gitDirectories) {
    if (resolvesWithin(realpathSync.native(gitDirectory), physicalDestination)) {
      throw new Error("The output path must not be inside a worktree or common Git directory.");
    }
  }
}

function parseTree(source) {
  const records = new Map();
  for (const record of source.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const header = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (tab < 0 || header.length !== 3 || !path) throw new Error("Could not parse the source Git tree.");
    records.set(path, { mode: header[0], type: header[1], object: header[2] });
  }
  return records;
}

function sourceMetadata(repoRoot, source) {
  const trackedStatus = git(repoRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=no",
    "--ignore-submodules=none",
  ]).trim();
  if (trackedStatus) {
    throw new Error(`Refusing to package a dirty tracked tree:\n${trackedStatus}`);
  }

  const revision = normalizeSourceRevision(source);
  const commit = git(repoRoot, ["rev-parse", "--verify", `${revision}^{commit}`]).trim();
  const tree = git(repoRoot, ["show", "-s", "--format=%T", commit]).trim();
  const timestampSeconds = Number(git(repoRoot, ["show", "-s", "--format=%ct", commit]).trim());
  if (!/^[0-9a-f]{40,64}$/.test(commit) || !/^[0-9a-f]{40,64}$/.test(tree)) {
    throw new Error("Git did not return canonical commit and tree object IDs.");
  }
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new Error("Git did not return a valid source commit timestamp.");
  }

  return {
    commit,
    tree,
    timestamp: new Date(timestampSeconds * 1000),
    treeRecords: parseTree(git(repoRoot, ["ls-tree", "-rz", commit], { binary: true })),
  };
}

function writeSourceFiles({ repoRoot, temporaryRoot, metadata }) {
  const entries = [];
  for (const path of [...HUMAN_TEST_SOURCE_FILES].sort()) {
    safeBundlePath(path);
    const record = metadata.treeRecords.get(path);
    if (!record) throw new Error(`Required human-test source is absent from ${metadata.commit}: ${path}`);
    if (record.type !== "blob" || !["100644", "100755"].includes(record.mode)) {
      throw new Error(`Required human-test source is not a regular Git blob: ${path}`);
    }

    const bytes = git(repoRoot, ["cat-file", "blob", `${metadata.commit}:${path}`], { binary: true });
    const destination = resolve(temporaryRoot, ...path.split("/"));
    assertInside(temporaryRoot, destination);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: "wx", mode: record.mode === "100755" ? 0o755 : 0o644 });
    if (process.platform !== "win32") chmodSync(destination, record.mode === "100755" ? 0o755 : 0o644);
    entries.push({
      path,
      mode: record.mode,
      gitBlob: record.object,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }
  return entries;
}

function stableManifest(metadata, entries) {
  return `${JSON.stringify(
    {
      schemaVersion: 2,
      bundleType: "doA2Ai-v1-network-human-test",
      sourceCommit: metadata.commit,
      sourceTree: metadata.tree,
      sourceCommitTimestampUtc: metadata.timestamp.toISOString(),
      files: entries,
    },
    null,
    2,
  )}\n`;
}

function stablePackageReadme(metadata) {
  return [
    "# doA2Ai V1 network human-test package",
    "",
    `Source commit: \`${metadata.commit}\``,
    `Source tree: \`${metadata.tree}\``,
    "",
    "This package contains the installable Chrome extension, the deployable service source,",
    "the locked product contract, and the live-network owner runbook. It intentionally contains",
    "no local demo, fake site, synthetic runtime, test fixture, captured review material, or secret.",
    "",
    "Start with `docs/REMOTE_JUDGE_RUNBOOK.md`. Load `extension/` through Chrome's",
    "**Load unpacked** flow only after this package and its externally recorded manifest hash",
    "have been verified. The first installed-Chrome and network acceptance run belongs to the owner.",
    "",
  ].join("\n");
}

function stableSums(entries, manifestBytes, packageReadmeBytes) {
  return `${[
    ...entries.map((entry) => `${entry.sha256}  ${entry.path}`),
    `${sha256(manifestBytes)}  ${manifestName}`,
    `${sha256(packageReadmeBytes)}  PACKAGE_README.md`,
  ].join("\n")}\n`;
}

function setStableTimes(root, timestamp) {
  const paths = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) utimesSync(path, timestamp, timestamp);
      else throw new Error(`Unexpected filesystem entry in generated package: ${path}`);
      paths.push(path);
    }
  }
  visit(root);
  for (const path of paths.reverse()) {
    if (lstatSync(path).isDirectory()) utimesSync(path, timestamp, timestamp);
  }
  utimesSync(root, timestamp, timestamp);
}

export function buildHumanTestPackage({ repoRoot = projectRoot, outputDir, source = "HEAD" } = {}) {
  const resolvedRepoRoot = resolve(repoRoot);
  const actualRoot = resolve(git(resolvedRepoRoot, ["rev-parse", "--show-toplevel"]).trim());
  if (actualRoot.toLowerCase() !== resolvedRepoRoot.toLowerCase()) {
    throw new Error(`Repository root mismatch: expected ${resolvedRepoRoot}, Git reported ${actualRoot}`);
  }
  if (typeof outputDir !== "string" || !outputDir.trim()) throw new Error("--output is required.");
  const destination = resolve(outputDir);
  if (existsSync(destination)) throw new Error(`Output path already exists: ${destination}`);
  const gitDirectories = [
    resolve(git(resolvedRepoRoot, ["rev-parse", "--absolute-git-dir"]).trim()),
    resolve(resolvedRepoRoot, git(resolvedRepoRoot, ["rev-parse", "--git-common-dir"]).trim()),
  ];
  const distinctGitDirectories = [];
  const seenGitDirectories = new Set();
  for (const gitDirectory of gitDirectories) {
    const key = process.platform === "win32" ? gitDirectory.toLowerCase() : gitDirectory;
    if (seenGitDirectories.has(key)) continue;
    seenGitDirectories.add(key);
    distinctGitDirectories.push(gitDirectory);
  }
  assertOutsideGitDirectories(destination, distinctGitDirectories);

  const metadata = sourceMetadata(resolvedRepoRoot, source);
  const outputParent = dirname(destination);
  mkdirSync(outputParent, { recursive: true });
  if (existsSync(destination)) throw new Error(`Output path appeared during package preparation: ${destination}`);
  assertOutsideGitDirectories(destination, distinctGitDirectories);
  const temporaryRoot = mkdtempSync(join(outputParent, `.${basename(destination)}.tmp-`));

  try {
    const entries = writeSourceFiles({ repoRoot: resolvedRepoRoot, temporaryRoot, metadata });
    const manifestBytes = Buffer.from(stableManifest(metadata, entries), "utf8");
    writeFileSync(join(temporaryRoot, "PACKAGE_README.md"), stablePackageReadme(metadata), { flag: "wx" });
    writeFileSync(join(temporaryRoot, manifestName), manifestBytes, { flag: "wx" });
    const packageReadmeBytes = readFileSync(join(temporaryRoot, "PACKAGE_README.md"));
    writeFileSync(join(temporaryRoot, sumsName), stableSums(entries, manifestBytes, packageReadmeBytes), { flag: "wx" });
    setStableTimes(temporaryRoot, metadata.timestamp);
    renameSync(temporaryRoot, destination);
    return Object.freeze({
      outputDir: destination,
      sourceCommit: metadata.commit,
      sourceTree: metadata.tree,
      fileCount: entries.length,
      manifestSha256: sha256(manifestBytes),
    });
  } catch (error) {
    if (existsSync(temporaryRoot)) rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function filesUnder(root) {
  const found = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) found.push(relative(root, absolute).split(sep).join("/"));
      else throw new Error(`Unexpected filesystem entry in package: ${absolute}`);
    }
  }
  visit(root);
  return found.sort();
}

export function verifyHumanTestPackage({ bundleDir, expectedManifestSha256 } = {}) {
  if (typeof bundleDir !== "string" || !bundleDir.trim()) throw new Error("--verify requires a package directory.");
  if (typeof expectedManifestSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(expectedManifestSha256.trim())) {
    throw new Error("Verification requires the externally recorded 64-character manifest SHA-256.");
  }
  const root = resolve(bundleDir);
  const manifestPath = join(root, manifestName);
  const sumsPath = join(root, sumsName);
  if (!existsSync(manifestPath) || !existsSync(sumsPath)) throw new Error("The package manifest or SHA256SUMS is missing.");

  const expectedPaths = [...HUMAN_TEST_SOURCE_FILES].sort();
  const expectedFiles = [...expectedPaths, ...HUMAN_TEST_GENERATED_FILES].sort();
  const actualFiles = filesUnder(root);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("The package contains missing or unexpected files.");
  }

  const manifestBytes = readFileSync(manifestPath);
  if (sha256(manifestBytes) !== expectedManifestSha256.trim().toLowerCase()) {
    throw new Error("The package manifest does not match the externally recorded SHA-256.");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    manifest.schemaVersion !== 2 ||
    manifest.bundleType !== "doA2Ai-v1-network-human-test" ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("The package manifest has an unsupported shape.");
  }

  const manifestPaths = manifest.files.map((entry) => safeBundlePath(entry.path));
  if (JSON.stringify(manifestPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("The manifest source-file set does not match the human-test allowlist.");
  }

  const packageReadmePath = join(root, "PACKAGE_README.md");
  const packageReadmeBytes = readFileSync(packageReadmePath);
  const expectedPackageReadme = stablePackageReadme({
    commit: manifest.sourceCommit,
    tree: manifest.sourceTree,
  });
  if (packageReadmeBytes.toString("utf8") !== expectedPackageReadme) {
    throw new Error("PACKAGE_README.md does not match the manifest-bound package identity.");
  }

  for (const entry of manifest.files) {
    const path = resolve(root, ...entry.path.split("/"));
    assertInside(root, path);
    const bytes = readFileSync(path);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`Package file failed SHA-256 verification: ${entry.path}`);
    }
  }

  const expectedSums = stableSums(manifest.files, manifestBytes, packageReadmeBytes);
  if (readFileSync(sumsPath, "utf8") !== expectedSums) throw new Error("SHA256SUMS does not match the package manifest.");
  return Object.freeze({
    sourceCommit: manifest.sourceCommit,
    sourceTree: manifest.sourceTree,
    fileCount: manifest.files.length,
    manifestSha256: sha256(manifestBytes),
  });
}

function usage() {
  return [
    "Build:  node scripts/build-human-test-package.mjs --output <new-directory> [--source <commit>]",
    "Verify: node scripts/build-human-test-package.mjs --verify <package-directory> --expected-manifest-sha256 <sha256>",
    "",
    "Build reads only committed Git blobs and refuses a dirty tracked tree or an existing output path.",
  ].join("\n");
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (!["--output", "--source", "--verify", "--expected-manifest-sha256"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    const key = argument.slice(2);
    if (key in options) throw new Error(`Duplicate argument: ${argument}`);
    options[key] = value;
    index += 1;
  }
  if (options.verify && (options.output || options.source)) {
    throw new Error("--verify cannot be combined with --output or --source.");
  }
  if (options.verify && !options["expected-manifest-sha256"]) throw new Error("--verify requires --expected-manifest-sha256.");
  if (!options.verify && options["expected-manifest-sha256"]) throw new Error("--expected-manifest-sha256 requires --verify.");
  return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else if (options.verify) {
      const result = verifyHumanTestPackage({
        bundleDir: options.verify,
        expectedManifestSha256: options["expected-manifest-sha256"],
      });
      console.log(`Verified ${result.fileCount} source files from ${result.sourceCommit}.`);
      console.log(`Source tree: ${result.sourceTree}`);
      console.log(`Manifest SHA-256: ${result.manifestSha256}`);
    } else {
      const result = buildHumanTestPackage({ outputDir: options.output, source: options.source ?? "HEAD" });
      console.log(`Built ${result.fileCount}-file human-test package at ${result.outputDir}.`);
      console.log(`Source commit: ${result.sourceCommit}`);
      console.log(`Source tree: ${result.sourceTree}`);
      console.log(`Manifest SHA-256: ${result.manifestSha256}`);
    }
  } catch (error) {
    console.error(`Human-test package error: ${error.message}`);
    console.error(usage());
    process.exitCode = 1;
  }
}
