# Production Readiness and Handover

## 1) Regression test confirmation

Executed locally:

- `npm run test:v2-parity` -> passed
- `npm run test:v2-perf` -> passed (`20000 rows`, `query bundle 14ms`)

Recommended manual regression checklist (before production):

- Auth + user management:
  - Login/logout
  - Create/edit/disable/reset user in `admin`
  - Role-based permission behavior in `dashboard`/`mobile`
- Data import:
  - Single file upload
  - Multi-file upload with one invalid file (verify partial success and `failedFiles`)
  - Progress text updates with current file, success count, failure count, dedup count
- Notification + DingTalk:
  - Load and save DingTalk notification config in `admin`
  - Send DingTalk test notification and verify `errcode=0`, `errmsg=ok`
- AI assistant:
  - Context sync success
  - Out-of-scope query returns permission denial message
  - Sensitive fields remain masked for non-privileged users

## 2) Fix/optimization guidance

If issues are found during regression, prioritize:

- UI/UX: keep feedback messages concise and explicit (`success`, `warning`, `error`)
- Feedback mechanism: never leave long-running action without visible progress
- Performance: prefer server-side pagination/query limits; avoid rendering huge lists at once

## 3) Production deployment preparation

Use `docs/windows-deployment-guide.md` as primary runbook.

Pre-deploy checks:

- `.env` completeness:
  - `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`
  - `PUBLIC_BASE_URL`
  - `DINGTALK_CORP_ID`, `DINGTALK_APP_KEY`, `DINGTALK_APP_SECRET`, `DINGTALK_AGENT_ID`, `DINGTALK_TEST_USER_ID`
  - `DATA_DIR`, `UPLOAD_DIR`, `DUCKDB_PATH`
  - `SESSION_STORE`, `SESSION_SECRET`
- Backup done (`data/`, `backend/data/`, `.env`)
- PM2 process healthy in staging before production switch

## 4) Handover notes

Key module ownership map:

- Auth/permissions: `backend/src/auth/*`
- Analytics + import API: `backend/src/routes/v2.js`
- Import parsing/merge/dedup: `backend/src/services/ingestionService.js`
- DingTalk notify test: `backend/src/services/dingtalkWorkNotifyService.js`
- Notification config persistence: `backend/src/services/notificationService.js`
- Admin UI: `admin.html`
- Dashboard UI + AI widget: `index.html`
- Mobile UI + AI panel: `mobile.html`

Operational files:

- Runtime data: `backend/data/*`
- Upload temp files: `backend/data/uploads/*`

## 5) Post-deployment monitoring

First 24h after deploy:

- Watch PM2 logs every 15-30 minutes
- Track:
  - Import failure rate
  - Average query response time
  - AI/chat error ratio
  - DingTalk notify error codes
- Triage priorities:
  1. Auth/permission bypass risk
  2. Data import breakage
  3. Dashboard/mobile unusable errors
  4. Non-critical UI defects

Emergency rollback trigger examples:

- Widespread login failure
- Import endpoint persistent 5xx
- Critical permission leakage
- Repeated DingTalk/API secret exposure risk in logs
