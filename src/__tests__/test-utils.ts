import fs from "node:fs";
import path from "node:path";

export function testPath(...segments: string[]): string {
  return path.resolve(process.cwd(), ".tmp", "tests", ...segments);
}

export function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Missing cleanup targets are fine in tests.
  }
}

export function resetDir(dirPath: string): void {
  fs.rmSync(dirPath, { recursive: true, force: true });
}
