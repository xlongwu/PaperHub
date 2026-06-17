import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runNode, runPnpm } from "./pnpm-runner.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(rootDir, ".tmp", "phase6-e2e");

const sharedEnv = {
  ...process.env,
  PAPERHUB_DATA_DIR: dataDir,
  PAPERHUB_PORT: "4310",
};

await runPnpm(["ui:build"], { cwd: rootDir, env: sharedEnv });
await runNode(["--import", "tsx", "scripts/seed-phase6-fixtures.ts", "--reset"], { cwd: rootDir, env: sharedEnv });
Object.assign(process.env, sharedEnv, {
  PAPERHUB_DISABLE_SCHEDULER: "1",
});

await import(pathToFileURL(path.join(rootDir, "src/index.ts")).href);
setInterval(() => {}, 60_000);
