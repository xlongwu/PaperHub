import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNode, runPnpm } from "./pnpm-runner.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(rootDir, ".tmp", "phase6-e2e");

const sharedEnv = {
  ...process.env,
  PAPERHUB_DATA_DIR: dataDir,
  PAPERHUB_DISABLE_SCHEDULER: "1",
};

await runPnpm(["ui:build"], { cwd: rootDir, env: sharedEnv });
await runNode(["--import", "tsx", "scripts/seed-phase6-fixtures.ts", "--reset"], { cwd: rootDir, env: sharedEnv });
await runNode(["node_modules/vitest/vitest.mjs", "run", "src/__tests__/phase6-release.test.tsx"], {
  cwd: rootDir,
  env: sharedEnv,
});
