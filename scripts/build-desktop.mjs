import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNode, runPnpm, withPnpmOnPath } from "./pnpm-runner.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.resolve(rootDir, "dist-desktop");
const isWindows = process.platform === "win32";
const args = process.argv.slice(2);
const targetArgs = args.includes("--dir")
  ? ["--dir", "--win", "--x64"]
  : args.includes("--portable")
    ? ["--win", "portable", "--x64"]
    : args.includes("--nsis")
      ? ["--win", "nsis", "--x64"]
      : ["--win", "nsis", "portable", "--x64"];
const electronVersion = readPackageJson().devDependencies.electron.replace(/^[^\d]*/, "");
const electronDist = resolveElectronDist();
const require = createRequire(import.meta.url);
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const nodeOptions = joinNodeOptions(process.env.NODE_OPTIONS, "--experimental-require-module");
const buildEnv = withPnpmOnPath(
  {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
  },
  rootDir,
);

assertReleaseHost();
cleanOutputDirectory();

await runPnpm(["ui:build"], {
  cwd: rootDir,
  env: {
    ...process.env,
  },
});

await ensureHostBetterSqlite();
const hostBetterSqliteSnapshot = snapshotHostBetterSqlite();
let electronBetterSqliteSnapshot = null;

try {
  await rebuildBetterSqliteForElectron();
  electronBetterSqliteSnapshot = snapshotBetterSqlite(
    path.join(rootDir, ".tmp", "native-electron", "better_sqlite3.node"),
  );

  await runNode(
    [
      "node_modules/electron-builder/cli.js",
      "--config.npmRebuild=false",
      ...(electronDist ? [`--config.electronDist=${electronDist}`] : []),
      ...targetArgs,
    ],
    {
      cwd: rootDir,
      env: buildEnv,
    },
  );
} finally {
  restoreHostBetterSqlite(hostBetterSqliteSnapshot);
  if (electronBetterSqliteSnapshot) {
    restorePackagedBetterSqlite(electronBetterSqliteSnapshot);
  }
}

verifyPackagedUi();
copyQuickTestLauncher();

function assertReleaseHost() {
  if (!isWindows) {
    throw new Error("PaperHub Windows packaging must run on a Windows host.");
  }

  // Relaxed from Node 20.x requirement — electron-builder 26+ works on newer Node
  if (nodeMajor < 20) {
    throw new Error(
      `PaperHub Windows packaging requires Node.js 20.x or later. Current: ${process.version}`,
    );
  }
}

function cleanOutputDirectory() {
  const relative = path.relative(rootDir, outputDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean output directory outside the project: ${outputDir}`);
  }

  fs.rmSync(outputDir, { recursive: true, force: true });
}

async function ensureHostBetterSqlite() {
  try {
    await verifyHostBetterSqlite();
    return;
  } catch {
    console.warn("[desktop-build] Restoring better-sqlite3 for the host Node runtime...");
  }

  const packageDir = path.dirname(require.resolve("better-sqlite3/package.json"));
  const prebuildInstaller = require.resolve("prebuild-install/bin.js", {
    paths: [packageDir, rootDir],
  });
  await runNode([prebuildInstaller], {
    cwd: packageDir,
    env: process.env,
  });
  await verifyHostBetterSqlite();
}

function verifyHostBetterSqlite() {
  return runNode(
    [
      "-e",
      "const Database=require('better-sqlite3');const db=new Database(':memory:');db.close();",
    ],
    {
      cwd: rootDir,
      env: process.env,
      stdio: "ignore",
    },
  );
}

async function rebuildBetterSqliteForElectron() {
  const electronRebuildMain = require.resolve("@electron/rebuild", {
    paths: [path.dirname(require.resolve("electron-builder/package.json"))],
  });
  const electronRebuildCli = path.join(path.dirname(electronRebuildMain), "cli.js");

  await runNode(
    [
      electronRebuildCli,
      "--version",
      electronVersion,
      "--arch",
      "x64",
      "--module-dir",
      rootDir,
      "--force",
      "--which-module",
      "better-sqlite3",
    ],
    {
      cwd: rootDir,
      env: buildEnv,
    },
  );
}

function snapshotHostBetterSqlite() {
  return snapshotBetterSqlite(path.join(rootDir, ".tmp", "native-host", "better_sqlite3.node"));
}

function snapshotBetterSqlite(snapshotPath) {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.copyFileSync(getBetterSqliteNativeModulePath(), snapshotPath);
  return snapshotPath;
}

function restoreHostBetterSqlite(snapshotPath) {
  const nativeModule = getBetterSqliteNativeModulePath();
  fs.copyFileSync(snapshotPath, nativeModule);
  console.log(`[desktop-build] Restored better-sqlite3 for host Node ${process.version}.`);
}

function restorePackagedBetterSqlite(snapshotPath) {
  const resourcesDir = path.join(outputDir, "win-unpacked", "resources");
  const candidates = [
    path.join(
      resourcesDir,
      "app",
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    ),
    path.join(
      resourcesDir,
      "app.asar.unpacked",
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    ),
  ];
  const packagedNativeModule = candidates.find((candidate) => fs.existsSync(candidate));

  if (!packagedNativeModule) {
    throw new Error("Packaged better-sqlite3 native module was not found.");
  }

  fs.copyFileSync(snapshotPath, packagedNativeModule);
  console.log("[desktop-build] Installed Electron-compatible better-sqlite3 in packaged app.");
}

function getBetterSqliteNativeModulePath() {
  const packageDir = path.dirname(require.resolve("better-sqlite3/package.json"));
  return path.join(packageDir, "build", "Release", "better_sqlite3.node");
}

function verifyPackagedUi() {
  const resourcesDir = path.join(outputDir, "win-unpacked", "resources");
  const appDir = path.join(resourcesDir, "app");
  const asarPath = path.join(resourcesDir, "app.asar");
  const readPackagedFile = fs.existsSync(appDir)
    ? (relativePath) => fs.readFileSync(path.join(appDir, relativePath))
    : createAsarReader(asarPath);

  const html = readPackagedFile("dist-ui/index.html").toString("utf-8");
  const scriptMatch = html.match(/<script[^>]+src="\/assets\/([^"]+\.js)"/);
  if (!scriptMatch?.[1]) {
    throw new Error("Could not locate the packaged UI JavaScript bundle.");
  }

  const bundlePath = path.join("dist-ui", "assets", scriptMatch[1]);
  const bundle = readPackagedFile(bundlePath).toString("utf-8");
  if (
    !bundle.includes("/api/llm/connections") ||
    !bundle.includes("LLM 连接管理") ||
    !bundle.includes("保存并启用")
  ) {
    throw new Error("Packaged UI does not contain the multi-provider LLM connection manager.");
  }

  console.log(`[desktop-build] Verified packaged LLM connection manager: ${bundlePath}`);
}

function copyQuickTestLauncher() {
  const source = path.join(rootDir, "PaperHub.bat");
  const destination = path.join(outputDir, "PaperHub-Quick-Test.bat");
  fs.copyFileSync(source, destination);
  console.log(`[desktop-build] Added quick launch test: ${path.relative(rootDir, destination)}`);
}

function createAsarReader(asarPath) {
  if (!fs.existsSync(asarPath)) {
    throw new Error(`Packaged application is missing: ${asarPath}`);
  }

  const electronBuilderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const asar = electronBuilderRequire("@electron/asar");
  return (relativePath) => asar.extractFile(asarPath, relativePath);
}

function resolveElectronDist() {
  const override = process.env.PAPERHUB_ELECTRON_DIST?.trim();
  if (override) {
    return path.resolve(override);
  }

  const cacheRoot =
    process.env.electron_config_cache?.trim() ||
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "electron", "Cache");
  if (!fs.existsSync(cacheRoot)) {
    return null;
  }

  const expectedName = `electron-v${electronVersion}-win32-x64.zip`;
  for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(cacheRoot, entry.name, expectedName);
    if (fs.existsSync(candidate)) {
      console.log(`[desktop-build] Using cached Electron distribution: ${candidate}`);
      return candidate;
    }
  }

  return null;
}

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"));
}

function joinNodeOptions(existing, addition) {
  return existing ? `${existing} ${addition}` : addition;
}
