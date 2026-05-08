# Windows Backup Readiness (Placeholder)

## Purpose

This project includes a **non-destructive placeholder backup script** for Windows deployment preparation.

Script path:

- `scripts/windows-backup-placeholder.ps1`

## What it backs up

The script copies the following paths (if present):

- `data/`
- `backend/data/`
- `.env`

Backups are stored under:

- `C:\apps\backups\sales-app-<timestamp>`

You can override this with `-BackupRoot`.

## Usage

From PowerShell:

```powershell
cd <project-root>
powershell -ExecutionPolicy Bypass -File .\scripts\windows-backup-placeholder.ps1
```

Custom paths:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows-backup-placeholder.ps1 -ProjectRoot "D:\sales-analysis-app" -BackupRoot "E:\backups\sales-analysis"
```

## Notes

- This is a placeholder for backup readiness, not a full retention/rotation policy.
- It does not delete any source files.
- It does not run cleanup or destructive operations.
- Real backup scheduling (Task Scheduler), retention policy, and restore drill should be configured in deployment operations.
