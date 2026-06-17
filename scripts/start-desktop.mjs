import { runNode, runPnpm } from "./pnpm-runner.mjs";

await runPnpm(["ui:build"], { env: process.env });
await runNode(["node_modules/electron/cli.js", "desktop/main.cjs"], { env: process.env });
