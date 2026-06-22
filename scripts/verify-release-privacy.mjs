import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SENSITIVE_ENV_NAME = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|CREDENTIAL)/i;
const TOP_LEVEL_PRIVATE_NAMES = new Set([
  ".env",
  "config.yml",
  "paperhub.yml",
  "paperhub.db",
  "credentials.json",
  "paperhub-secret-key.bin",
]);
const TOP_LEVEL_PRIVATE_DIRECTORIES = new Set(["data", "logs", "secrets", "digests"]);
const HIGH_CONFIDENCE_CREDENTIAL_PATTERNS = [
  { name: "API key", pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g },
  { name: "Tavily key", pattern: /\btvly-[A-Za-z0-9_-]{16,}\b/g },
  { name: "GitHub token", pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { name: "Google API key", pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
];

export function verifyReleasePrivacy({ appDir, rootDir, environment = process.env }) {
  const resolvedAppDir = path.resolve(appDir);
  const resolvedRootDir = path.resolve(rootDir);
  if (!fs.existsSync(resolvedAppDir) || !fs.statSync(resolvedAppDir).isDirectory()) {
    throw new Error(`Packaged application directory does not exist: ${resolvedAppDir}`);
  }

  const files = walkFiles(resolvedAppDir);
  const violations = [];
  for (const filePath of files) {
    const relativePath = normalizeRelative(path.relative(resolvedAppDir, filePath));
    if (isPrivateReleasePath(relativePath)) {
      violations.push(`private file or directory: ${relativePath}`);
    }
    if (!relativePath.startsWith("node_modules/") && fs.statSync(filePath).size <= 8 * 1024 * 1024) {
      const text = fs.readFileSync(filePath, "utf8");
      for (const credentialPattern of HIGH_CONFIDENCE_CREDENTIAL_PATTERNS) {
        credentialPattern.pattern.lastIndex = 0;
        if (credentialPattern.pattern.test(text)) {
          violations.push(`${credentialPattern.name} pattern appears in ${relativePath}`);
        }
      }
    }
  }

  const sensitiveValues = collectSensitiveValues(resolvedRootDir, environment);
  for (const { name, value } of sensitiveValues) {
    const needle = Buffer.from(value, "utf8");
    for (const filePath of files) {
      if (fs.statSync(filePath).size > 32 * 1024 * 1024) continue;
      if (fs.readFileSync(filePath).includes(needle)) {
        violations.push(
          `configured credential ${name} appears in ${normalizeRelative(
            path.relative(resolvedAppDir, filePath),
          )}`,
        );
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Release privacy verification failed:\n${violations.map((item) => `- ${item}`).join("\n")}`,
    );
  }

  return {
    filesChecked: files.length,
    credentialValuesChecked: sensitiveValues.length,
  };
}

export function collectSensitiveValues(rootDir, environment = process.env) {
  const values = new Map();
  for (const [name, value] of Object.entries(environment)) {
    addSensitiveValue(values, name, value);
  }

  const envPath = path.join(rootDir, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
      if (!match) continue;
      addSensitiveValue(values, match[1], unquote(match[2].trim()));
    }
  }

  return [...values.entries()].map(([name, value]) => ({ name, value }));
}

export function isPrivateReleasePath(relativePath) {
  const normalized = normalizeRelative(relativePath);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  const topLevel = parts[0].toLowerCase();
  const basename = parts.at(-1).toLowerCase();

  if (TOP_LEVEL_PRIVATE_DIRECTORIES.has(topLevel)) return true;
  if (parts.length === 1 && TOP_LEVEL_PRIVATE_NAMES.has(basename)) return true;
  if (parts.length === 1 && (basename.startsWith(".env.") || basename.endsWith(".log"))) {
    return true;
  }
  if (
    topLevel !== "node_modules" &&
    (basename.endsWith(".db") || basename.endsWith(".sqlite") || basename.endsWith(".sqlite3"))
  ) {
    return true;
  }
  return false;
}

function addSensitiveValue(values, name, value) {
  if (!SENSITIVE_ENV_NAME.test(name) || typeof value !== "string") return;
  const normalized = value.trim();
  if (normalized.length < 12) return;
  values.set(name, normalized);
}

function walkFiles(directory) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  return files;
}

function normalizeRelative(value) {
  return value.replaceAll("\\", "/");
}

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseCliArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Usage: verify-release-privacy --app-dir <path> --root-dir <path>");
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = parseCliArguments(process.argv.slice(2));
  const result = verifyReleasePrivacy({
    appDir: args["app-dir"],
    rootDir: args["root-dir"],
  });
  console.log(
    `[release-privacy] Verified ${result.filesChecked} packaged files; checked ` +
      `${result.credentialValuesChecked} configured credential values.`,
  );
}
