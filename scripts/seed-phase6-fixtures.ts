import fs from "node:fs";
import path from "node:path";
import { getDbPath } from "@/config";
import { insertDocument } from "@/db/documents";
import { closeDb, initDatabase } from "@/db/index";
import { refreshTagStats } from "@/db/tags";
import { addFavorite, initDefaultPreferences, recordHistory, setUserPreference } from "@/db/user";
import { rebuildUserMemoryFromDigests, refreshHotRecommendations } from "@/recommendation";
import {
  createPhase6FixtureDocuments,
  PHASE6_DEFAULT_PREFERENCES,
  PHASE6_FIXTURE_NOW,
} from "@/test-support/phase6-fixtures";

const reset = process.argv.includes("--reset");
if (!process.env["PAPERHUB_DATA_DIR"] && !process.env["PAPERHUB_DB_PATH"]) {
  process.env["PAPERHUB_DATA_DIR"] = path.resolve(process.cwd(), ".tmp", "phase6-local");
}
const dbPath = getDbPath();

closeDb();
if (reset) {
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
}

initDatabase();
initDefaultPreferences();

const documents = createPhase6FixtureDocuments();
for (const document of documents) {
  insertDocument(document);
}

for (const [key, value] of Object.entries(PHASE6_DEFAULT_PREFERENCES)) {
  setUserPreference(key, value);
}

recordHistory("doc-e2e-agent-memory");
addFavorite("doc-e2e-rag-systems");

refreshTagStats();
rebuildUserMemoryFromDigests({
  maxDays: 30,
  maxTerms: 24,
  now: new Date(PHASE6_FIXTURE_NOW),
});
refreshHotRecommendations({
  limit: 12,
  includeRead: true,
  now: new Date(PHASE6_FIXTURE_NOW),
});

console.log(
  `[phase6-fixtures] Seeded ${documents.length} documents into ${dbPath} with fixed now ${PHASE6_FIXTURE_NOW}.`,
);
