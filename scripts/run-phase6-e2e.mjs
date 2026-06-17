import path from "node:path";
import { spawn } from "node:child_process";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dataDir = path.join(rootDir, ".tmp", "phase6-e2e");
const isWindows = process.platform === "win32";
const pnpmBin = isWindows ? "pnpm.cmd" : "pnpm";
const nodeBin = isWindows ? "node.exe" : "node";

const sharedEnv = {
  ...process.env,
  PAPERHUB_DATA_DIR: dataDir,
  PAPERHUB_DISABLE_SCHEDULER: "1",
};

await run(pnpmBin, ["ui:build"], sharedEnv);
await run(nodeBin, ["--import", "tsx", "scripts/seed-phase6-fixtures.ts", "--reset"], sharedEnv);
await run(pnpmBin, ["exec", "vitest", "run", "src/__tests__/phase6-release.test.tsx"], sharedEnv);

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      env,
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}
