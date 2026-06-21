import "dotenv/config";
import readline from "node:readline";
import { closeDb, initDatabase } from "@/db/index";
import { handlePaperHubMcpRequest } from "./server";

console.log = (...args: unknown[]) => console.error(...args);

initDatabase();

const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

lines.on("line", (line) => {
  const value = line.trim();
  if (!value) return;
  void respond(value);
});

lines.on("close", () => {
  closeDb();
});

async function respond(line: string): Promise<void> {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      })}\n`,
    );
    return;
  }
  const response = await handlePaperHubMcpRequest(request);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
}
