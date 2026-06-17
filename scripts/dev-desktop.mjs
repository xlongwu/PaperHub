import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const bin = isWindows ? "pnpm.cmd" : "pnpm";

const api = spawn(bin, ["api:dev"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PAPERHUB_DISABLE_SCHEDULER: "1",
  },
});

const ui = spawn(bin, ["ui:dev"], {
  stdio: "inherit",
  env: process.env,
});

setTimeout(() => {
  spawn(bin, ["exec", "electron", "desktop/main.cjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      PAPERHUB_DESKTOP_DEV: "1",
      PAPERHUB_UI_URL: "http://127.0.0.1:4173",
    },
  });
}, 4500);

function shutdown(code = 0) {
  api.kill();
  ui.kill();
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
api.on("exit", (code) => {
  if (code && code !== 0) {
    shutdown(code);
  }
});
ui.on("exit", (code) => {
  if (code && code !== 0) {
    shutdown(code);
  }
});
