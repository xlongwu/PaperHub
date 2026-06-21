# PaperHub W7 Windows Release Runbook

## Release host

- Windows 10/11 x64
- Node.js 20 or later
- pnpm 9
- A clean, isolated `PAPERHUB_DATA_DIR` for release verification

## Automated verification

```powershell
pnpm release:verify
pnpm desktop:build:dir
pnpm desktop:build:nsis
pnpm desktop:build:portable
```

Expected artifacts:

- `dist-desktop/PaperHub-<version>-setup-x64.exe`
- `dist-desktop/PaperHub-<version>-portable-x64.exe`

The packaging script verifies that the Web Search monitoring UI, MCP server, SecretStore implementation,
and all three bundled Skills are present in the packaged application.

## Credential migration

Schema v24 moves LLM, embedding, and Web Search API keys from SQLite into the encrypted SecretStore.
Electron protects the SecretStore master key with Windows DPAPI through `safeStorage`; the backend
encrypts individual values using AES-256-GCM.

Before upgrading a real profile:

1. Close all PaperHub processes.
2. Copy `%USERPROFILE%\PaperHub` to offline backup storage.
3. Start the new build once and confirm the database reaches v24.
4. Confirm provider connections still report `hasApiKey=true`.
5. Search the database and logs for a known test-key fragment; no match is allowed.

PaperHub also creates `paperhub.db.pre-v24-from-v23.bak` before migration. If migration or
`PRAGMA quick_check` fails, startup stops and retains that backup.

## Isolated release smoke

Set an empty release directory before launching each artifact:

```powershell
$env:PAPERHUB_DATA_DIR="$env:TEMP\PaperHub-W7-Smoke"
$env:PAPERHUB_DISABLE_SCHEDULER="1"
```

Run the installer and Portable version separately. For each one:

1. Launch and wait for the Home page.
2. Configure a disposable Web provider key and confirm the key is not echoed back.
3. Run an arXiv Web search.
4. Generate a cited summary when an LLM connection is available.
5. Save one result and confirm it appears in Local Library search.
6. Close the app during a second search, restart, and confirm the interrupted session is recoverable.
7. Open User Center → Web Search status and confirm health, cost, cache, and cleanup information.
8. Confirm external links open in the system browser and non-HTTP links are rejected.

## Rollback

1. Exit PaperHub.
2. Preserve the v24 database and logs for diagnosis.
3. Restore the pre-v24 database backup and the matching pre-release data directory.
4. Reinstall the previous PaperHub build.

Do not copy encrypted credential files between Windows user accounts: DPAPI protection is user-bound.
