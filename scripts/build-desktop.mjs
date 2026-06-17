import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNode, runPnpm, withPnpmOnPath } from "./pnpm-runner.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const args = process.argv.slice(2);
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

await runPnpm(["ui:build"], {
  cwd: rootDir,
  env: {
    ...process.env,
  },
});

await runNode(["node_modules/electron-builder/install-app-deps.js", "--arch=x64"], {
  cwd: rootDir,
  env: buildEnv,
});

await runNode(
  [
    "node_modules/electron-builder/cli.js",
    ...(args.includes("--dir") ? ["--dir", "--win", "--x64"] : ["--win", "nsis", "portable", "--x64"]),
  ],
  {
    cwd: rootDir,
    env: buildEnv,
  },
);

function assertReleaseHost() {
  if (!isWindows) {
    throw new Error("PaperHub Windows packaging must run on a Windows host.");
  }

  if (nodeMajor !== 20) {
    throw new Error(
      `PaperHub Windows packaging requires Node.js 20.x LTS because electron-builder install-app-deps is not stable on Node ${process.version}.`,
    );
  }
}

function joinNodeOptions(existing, addition) {
  return existing ? `${existing} ${addition}` : addition;
}
