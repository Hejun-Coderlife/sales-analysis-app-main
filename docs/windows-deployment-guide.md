# Windows Safe Deployment Guide (Production + Staging)

## Directory layout

- Production: `C:\apps\sales-app`
- Staging: `C:\apps\sales-app-staging`
- Backups: `C:\apps\backups`

Use staging to validate every update before touching production.

## Environment examples

Set these per environment in `.env`:

- `PORT`
- `DATA_DIR`
- `UPLOAD_DIR`
- `DUCKDB_PATH`
- `SESSION_STORE`
- `PUBLIC_BASE_URL`

Recommended:

- Production: `PORT=3000`, `PUBLIC_BASE_URL=https://<your-production-domain>`
- Staging: `PORT=3001`, `PUBLIC_BASE_URL=https://<your-staging-domain-or-host>`

## PM2 process names and ports

Production (`sales-app`, port 3000):

```powershell
cd C:\apps\sales-app
pm2 start server.js --name sales-app
pm2 restart sales-app
pm2 logs sales-app
```

Staging (`sales-app-staging`, port 3001):

```powershell
cd C:\apps\sales-app-staging
pm2 start server.js --name sales-app-staging
pm2 restart sales-app-staging
pm2 logs sales-app-staging
```

## Safe deployment workflow

1) Backup before update

```powershell
cd C:\apps\sales-app
powershell -ExecutionPolicy Bypass -File .\scripts\windows-backup-placeholder.ps1 -ProjectRoot "C:\apps\sales-app" -BackupRoot "C:\apps\backups"
```

2) Update staging first

```powershell
cd C:\apps\sales-app-staging
git fetch --all
git pull
npm install
pm2 restart sales-app-staging
```

3) Verify staging

- Open staging URL and check login, dashboard, mobile pages.
- Verify no critical runtime errors in browser console and PM2 logs.
- Confirm expected environment (`PORT=3001`, staging data paths).

4) Update production only after staging passes

```powershell
cd C:\apps\sales-app
git fetch --all
git pull
npm install
pm2 restart sales-app
```

5) Verify production after restart

- Open production URL and verify core paths:
  - `/login`
  - `/dashboard`
  - `/mobile`
- Check process and logs:

```powershell
pm2 status
pm2 logs sales-app --lines 100
```

## Rollback guide

If production verification fails:

1) Roll code back to previous known-good commit:

```powershell
cd C:\apps\sales-app
git checkout <previous_commit_sha>
npm install
pm2 restart sales-app
```

2) If required, restore backup content:

- Restore `data/`
- Restore `backend/data/`
- Restore `.env`

Use latest backup folder such as:

- `C:\apps\backups\sales-app-YYYYMMDD-HHMMSS`

3) Re-verify production and keep staging unchanged for investigation.
