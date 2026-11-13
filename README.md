# SvitloRadar

Cloudflare Worker serving cached electricity outage schedules from a configured
upstream API. The `DB` binding points to `svitlo-db`; the configured Cron is `*/15 * * * *` (UTC).
Public requests read D1 only. There is no public refresh endpoint.

## API

- `GET /api/status`: `ok`, `stale` (last successful validation more than 20 minutes
  ago), or `waiting` (no usable snapshot, HTTP 503). Read/schema failures are
  logged and return 503. Stale snapshots remain available with HTTP 200.
- `GET /api/groups`: `{ groups, updatedAt }`, preserving the upstream group IDs.
- `GET /api/schedule?group=1`: `{ group, updatedAt, schedule }`; accepts 1–12.
  Invalid or repeated parameters return 400.

`updated_at` / `updatedAt` means the last successful upstream check, even when
content was unchanged. `next_expected_refresh` is the next configured UTC Cron
boundary, not a guarantee of completion or proof that the trigger is deployed.
Timestamps remain UTC; clients should display them using `Europe/Kyiv`.
Availability mapping is provisional: 0 available, 1 unavailable, 2 possible outage.

Refresh uses two upstream requests, with a 15-second timeout each, and validates
group mapping, schedule fields, duplicate slots and coverage of all 12 groups.
Failures are logged and never replace the previous snapshot. Unknown fields are
preserved. Valid payloads are sorted before comparison. Unchanged payloads only
update the small timestamp field: a heartbeat write is necessary to track freshness.
There are no automatic upstream retries. Structural validation cannot prove the
upstream has supplied a complete time horizon or current information.

## Private upstream configuration

The upstream origin is supplied through `UPSTREAM_BASE_URL`, with no source-code
fallback. Copy `.dev.vars.example` to `.dev.vars` and set the real HTTPS origin.
`.dev.vars` and `.env` files are ignored by Git. Never commit real values in examples.
For production, set the encrypted Worker secret before deploying:

```sh
npx wrangler secret put UPSTREAM_BASE_URL
```

Enter the origin at the interactive prompt. This follows
[Cloudflare's secret configuration](https://developers.cloudflare.com/workers/configuration/secrets/).
The D1 database ID in Wrangler is a resource identifier, not a credential.

## Local validation

```sh
npm test -- --run
npx wrangler d1 migrations apply svitlo-db --local
npx wrangler dev
```

In another terminal:

```sh
curl 'http://localhost:8787/cdn-cgi/local/scheduled?format=json'
curl 'http://localhost:8787/api/status'
curl 'http://localhost:8787/api/groups'
curl 'http://localhost:8787/api/schedule?group=1'
curl -i 'http://localhost:8787/api/schedule?group=13'
```

The scheduled test route is provided by Wrangler locally, not by this Worker's
public fetch handler. Local D1 is separate from production.

## Production deployment

The production Worker is `svitlo-radar` at
`https://svitlo-radar.hexace.workers.dev`. It was renamed in place from
`svitlo-aggregator`, preserving the Worker identity and existing `svitlo-db`
database. `UPSTREAM_BASE_URL` is configured as a production secret.
Local `.dev.vars` values are not automatically uploaded during deployment.

Review changes, run tests, then:

```sh
npx wrangler d1 migrations list svitlo-db --remote
npx wrangler d1 migrations apply svitlo-db --remote
npx wrangler deploy --dry-run
npx wrangler deploy
npx wrangler deployments status
curl 'https://svitlo-radar.hexace.workers.dev/api/status'
curl 'https://svitlo-radar.hexace.workers.dev/api/groups'
curl 'https://svitlo-radar.hexace.workers.dev/api/schedule?group=1'
```

Migration 0001 uses `CREATE TABLE IF NOT EXISTS` to preserve existing data.
Confirm the deployed `DB` database ID matches `wrangler.jsonc`, and verify
`*/15 * * * *` in Cloudflare Dashboard → Worker → Settings → Triggers.
Cron changes can take up to 15 minutes to propagate. Observe a subsequent
`updated_at` advance, and inspect scheduled events/logs (`npx wrangler tail`)
for `refresh_success` or `refresh_failed`. Check again after another boundary
if diagnosing whether refreshes recur.

Read-only schema/snapshot diagnostic:

```sh
npx wrangler d1 execute svitlo-db --remote --command "SELECT name, sql FROM sqlite_master WHERE type='table'; SELECT id, updated_at, length(data) AS bytes FROM snapshots;"
```

## Production deployment verification

Deployed on 2026-11-13 (Europe/Kyiv), version
`ec2d31cf-2ebc-4f97-8295-3b7176d54654`. The remote migration
`0001_snapshots.sql` was applied without replacing the existing snapshot.
The deployed Cron expression is `*/15 * * * *`.

Post-deployment checks returned HTTP 200 for status, groups, and group 1's
schedule, and HTTP 400 for group 13. The cached snapshot contained 12 groups
and 576 entries; group 1 mapped to upstream ID 3 with 48 entries.
An automatic Cron invocation on the deployed version completed successfully at
`2026-11-13T00:15:59.049Z` (02:15:59 Europe/Kyiv), logging `refresh_success`
and advancing the snapshot timestamp. Only one Worker exists after the rename.
The historical empty-snapshot issue was not reproduced; its cause remains
unconfirmed.

Cloudflare references: [migrations](https://developers.cloudflare.com/d1/reference/migrations/),
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
