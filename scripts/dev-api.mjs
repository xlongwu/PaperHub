import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const api = spawn(process.execPath, ["--watch", "--import", "tsx", "src/index.ts"], {
  cwd: rootDir,
  stdio: "inherit",
  env: {
    ...process.env,
    PAPERHUB_DISABLE_SCHEDULER: "1",
  },
});

function shutdown(code = 0) {
  api.kill();
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
api.on("exit", (code) => {
  process.exit(code ?? 0);
});
