import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function spawnPnpm(args, options = {}) {
  const invocation = getPnpmInvocation(args);
  return spawn(invocation.command, invocation.args, options);
}

export function spawnNode(args, options = {}) {
  return spawn(process.execPath, args, options);
}

export function runPnpm(args, options = {}) {
  const invocation = getPnpmInvocation(args);

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: "inherit",
      ...options,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${invocation.command} ${invocation.args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

export function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnNode(args, {
      stdio: "inherit",
      ...options,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${process.execPath} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

export function withPnpmOnPath(env = process.env, rootDir = process.cwd()) {
  if (process.platform !== "win32") {
    return env;
  }

  const invocation = getWindowsCorepackInvocation([]);
  if (!invocation) {
    return env;
  }

  const shimDir = path.join(rootDir, ".tmp", "pnpm-shim");
  fs.mkdirSync(shimDir, { recursive: true });

  const shimPath = path.join(shimDir, "pnpm.cmd");
  const quotedArgs = invocation.args.map((arg) => `"${arg}"`).join(" ");
  fs.writeFileSync(shimPath, `@echo off\r\n"${invocation.command}" ${quotedArgs} %*\r\n`);
  const basePath = env["Path"] ?? env["PATH"] ?? "";
  const nextPath = [
    shimDir,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    "C:\\Windows\\System32",
    "C:\\Windows",
    basePath,
  ].join(path.delimiter);

  return {
    ...env,
    PATH: nextPath,
    Path: nextPath,
  };
}

function getPnpmInvocation(args) {
  if (process.platform === "win32") {
    const corepackInvocation = getWindowsCorepackInvocation(args);
    if (corepackInvocation) {
      return corepackInvocation;
    }
  }

  return {
    command: "pnpm",
    args,
  };
}

function getWindowsCorepackInvocation(args) {
  const pathDirs = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  const candidateDirs = [path.dirname(process.execPath), ...pathDirs];

  for (const dir of candidateDirs) {
    const nodeExe = path.join(dir, "node.exe");
    const corepackJs = path.join(dir, "node_modules", "corepack", "dist", "corepack.js");
    if (fs.existsSync(nodeExe) && fs.existsSync(corepackJs)) {
      return {
        command: nodeExe,
        args: [corepackJs, "pnpm", ...args],
      };
    }
  }

  return null;
}
