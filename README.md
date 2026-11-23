# PreBana2

## Vercel account and product storage

Vercel deployments use MySQL for account, product, and order storage; local development continues to use the JSON files. Configure these environment variables in the Vercel project settings. Either naming scheme is supported:

- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- Clever Cloud: `MYSQL_ADDON_HOST`, `MYSQL_ADDON_PORT`, `MYSQL_ADDON_USER`, `MYSQL_ADDON_PASSWORD`, `MYSQL_ADDON_DB`, or `MYSQL_ADDON_URI`
- `DB_SSL=true` if required by the MySQL provider

The application creates the `prebana_users`, `prebana_products`, and `prebana_orders` tables on first use and imports existing records from the bundled JSON files once. The MySQL user must be allowed to create tables and select, insert, update, and delete rows. Product images are stored in the public Vercel Blob store `my-blob-store`, connected to the `pre-bana-cosmetics` Vercel project for production, preview, and development. Vercel Blob uses OIDC for the project connection, so a long-lived `BLOB_READ_WRITE_TOKEN` is not required. For local Vercel development, link the project and run `vercel env pull .env.local`; do not commit the resulting credentials.

Set a unique, randomly generated `JWT_SECRET` in Vercel as well; the placeholder in `.env.example` is not suitable for production.

To create the initial administrator, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in the deployment environment (or local ignored `.env`) before starting the app. Use a unique password; it must be 12–72 bytes. The password is stored as a bcrypt hash, and these settings do not reset an existing admin account. If the configured email belongs to a non-admin account, startup fails instead of changing its role.

Provision the hosted MySQL database separately; the application creates its tables, not the database server. Vercel order writes use MySQL rather than the function's read-only filesystem, while local order writes continue to use `src/data/orders.json`.

## GitHub CI and Vercel deployments

The GitHub Actions workflow in `.github/workflows/ci.yml` runs on pull requests and pushes to `main`. It installs the locked dependencies and runs `npm test`, which checks JavaScript syntax and compiles the EJS templates. Run the same check locally with `npm test`.

After validation succeeds on a push to `main`, the workflow triggers the Vercel Deploy Hook. Add its URL as the `VERCEL_DEPLOY_HOOK_URL` repository secret in GitHub under **Settings → Secrets and variables → Actions**. The workflow never stores the URL in the repository. Configure the hook for the production branch (`main`). Pull requests run validation but do not trigger this hook. If Vercel's automatic Git deployment also deploys pushes to `main`, disable one of the production deployment triggers to avoid duplicate builds.

For Vercel preview and production deployments, import this GitHub repository into Vercel (or connect it in the Vercel project's **Settings → Git**) and set `main` as the production branch. Vercel then creates preview deployments for pull requests and production deployments for pushes to `main`. Configure the database and `JWT_SECRET` environment variables in the Vercel project for the appropriate deployment environments; the Blob connection supplies its own environment variables. The GitHub Actions check does not itself deploy to Vercel; require the `CI / validate` status check in GitHub branch protection if merges must wait for validation.

## Local M-Pesa callback testing

Safaricom cannot reach a callback URL on `localhost`. When initiating STK Push from the local app, expose its port (8080 by default) with an HTTPS tunnel, then set the local `MPESA_CALLBACK_URL` to `https://<tunnel-host>/api/mpesa/callback` and restart the app. For example, `ngrok http 8080` provides a temporary HTTPS host.

Do not point a local checkout at the Vercel callback URL unless both deployments share persistent order storage. Local orders are stored in `src/data/orders.json`, which is separate from the Vercel deployment's data. Start a new STK request after changing the callback URL; existing requests keep the callback URL sent with that request.