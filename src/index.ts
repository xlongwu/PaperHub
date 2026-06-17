/**
 * PaperHub main entry point.
 * Initializes database, starts API server, and starts scheduler.
 */

import "dotenv/config";
import { initDatabase, closeDb } from "@/db/index";
import { startServer } from "@/api/server";
import { startScheduler, stopScheduler } from "@/scheduler";
import { getLogsDir } from "@/config";
import { initDefaultPreferences } from "@/db/user";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Logging setup
// ---------------------------------------------------------------------------

function setupLogging(): void {
  const dir = getLogsDir();
  const file = path.join(dir, "app.log");

  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
    originalLog(...args);
    try {
      fs.appendFileSync(file, line, "utf-8");
    } catch {}
  };

  console.error = (...args: unknown[]) => {
    const line = `[${new Date().toISOString()}] ERROR: ${args.join(" ")}\n`;
    originalError(...args);
    try {
      fs.appendFileSync(file, line, "utf-8");
    } catch {}
  };
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function setupShutdownHandlers(server: ReturnType<typeof startServer>): void {
  const shutdown = (signal: string) => {
    console.log(`[app] Received ${signal}, shutting down gracefully...`);

    stopScheduler();
    server.close(() => {
      console.log("[app] Server closed.");
      closeDb();
      console.log("[app] Database closed.");
      process.exit(0);
    });

    // Force exit after 10s
    setTimeout(() => {
      console.error("[app] Forced exit after timeout.");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("[app] PaperHub starting...");

  setupLogging();

  // 1. Init database
  initDatabase();
  console.log("[app] Database initialized.");

  // 1.5. Init default user preferences
  initDefaultPreferences();
  console.log("[app] User preferences initialized.");

  // 2. Start API server
  const server = startServer();

  // 3. Start scheduler
  if (process.env["PAPERHUB_DISABLE_SCHEDULER"] === "1") {
    console.log("[app] Scheduler disabled by PAPERHUB_DISABLE_SCHEDULER=1.");
  } else {
    startScheduler(true);
  }

  // 4. Setup shutdown handlers
  setupShutdownHandlers(server);

  console.log("[app] PaperHub is ready.");
}

main().catch((err) => {
  console.error("[app] Fatal error:", err);
  process.exit(1);
});
