import { spawn } from "node:child_process";
import path from "node:path";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const isWindows = process.platform === "win32";
const pnpmBin = isWindows ? "pnpm.cmd" : "pnpm";
const args = process.argv.slice(2);
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const nodeOptions = joinNodeOptions(process.env.NODE_OPTIONS, "--experimental-require-module");

assertReleaseHost();

await run(pnpmBin, ["ui:build"], {
  ...process.env,
});

await run(pnpmBin, ["exec", "electron-builder", "install-app-deps", "--arch=x64"], {
  ...process.env,
  NODE_OPTIONS: nodeOptions,
});

await run(
  pnpmBin,
  [
    "exec",
    "electron-builder",
    ...(args.includes("--dir") ? ["--dir", "--win", "--x64"] : ["--win", "nsis", "portable", "--x64"]),
  ],
  {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
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

function run(command, argv, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd: rootDir,
      stdio: "inherit",
      env,
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${argv.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

function joinNodeOptions(existing, addition) {
  return existing ? `${existing} ${addition}` : addition;
}
