# PreBana2

## Vercel account storage

Vercel deployments use MySQL for account storage; local development without database variables continues to use `src/data/users.json`. Configure these environment variables in the Vercel project settings. Either naming scheme is supported:

- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- Clever Cloud: `MYSQL_ADDON_HOST`, `MYSQL_ADDON_PORT`, `MYSQL_ADDON_USER`, `MYSQL_ADDON_PASSWORD`, `MYSQL_ADDON_DB`, or `MYSQL_ADDON_URI`
- `DB_SSL=true` if required by the MySQL provider

The application creates the `prebana_users` table on first use and imports existing accounts from `src/data/users.json` without replacing records already in MySQL. The MySQL user must have permission to create tables. Redeploy after setting the variables. Do not commit credentials or paste them into source files.

To create the initial administrator, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the deployment environment (or local ignored `.env`) before starting the app. Use a unique password; it must be 12–72 bytes. The password is stored as a bcrypt hash, and these settings do not reset an existing admin account. If the configured email belongs to a non-admin account, startup fails instead of changing its role.

Provision the hosted MySQL database separately; the application creates its user table, not the database server. This change moves account storage only. Product and order data still use JSON files and need a persistent store before those write flows can work reliably on Vercel.

## Local M-Pesa callback testing

Safaricom cannot reach a callback URL on `localhost`. When initiating STK Push from the local app, expose its port (8080 by default) with an HTTPS tunnel, then set the local `MPESA_CALLBACK_URL` to `https://<tunnel-host>/api/mpesa/callback` and restart the app. For example, `ngrok http 8080` provides a temporary HTTPS host.

Do not point a local checkout at the Vercel callback URL unless both deployments share persistent order storage. Local orders are stored in `src/data/orders.json`, which is separate from the Vercel deployment's data. Start a new STK request after changing the callback URL; existing requests keep the callback URL sent with that request.