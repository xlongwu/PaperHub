import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const bin = isWindows ? "pnpm.cmd" : "pnpm";

await run(bin, ["ui:build"]);
await run(bin, ["exec", "electron", "desktop/main.cjs"]);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
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
