import { spawnNode, spawnPnpm } from "./pnpm-runner.mjs";

const api = spawnPnpm(["api:dev"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PAPERHUB_DISABLE_SCHEDULER: "1",
  },
});

const ui = spawnPnpm(["ui:dev"], {
  stdio: "inherit",
  env: process.env,
});

setTimeout(() => {
  spawnNode(["node_modules/electron/cli.js", "desktop/main.cjs"], {
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
