# Events and service checks

Open **Monitors / 服务监控** from the session menu. Each rule belongs to the
signed-in namespace and a selected Runner/directory. No rules or network
requests are created just by installing the feature.

## Create a rule

- **Webhook**: another system reports an incident to SHAPI. Choose the Runner,
  absolute existing directory, Codex or Claude, model, investigation prompt,
  expiry, and the permission mode used *after* repair approval.
- **Probe**: SHAPI checks an HTTP(S) endpoint from the **Hub's network**, not the
  Runner's network. Choose the method, expected status, optional response text,
  timeout and interval (60 seconds–24 hours). Importing curl fills these fields;
  it does not execute a shell or send a request.
- **Scheduled**: run daily at a chosen time, weekly on a chosen weekday/time,
  or using a five-field cron expression. The selected IANA timezone is saved
  with the rule. Minute resolution; dispatch is checked every ten seconds.
  After downtime, at most one missed occurrence is admitted; there is no
  catch-up storm. A rule with an open incident coalesces later occurrences.
- Use the session detail menu to create a rule bound to that exact managed or
  native Codex session. Environment fields are hidden and resolved server-side;
  the rule cannot be retargeted. The list includes a session shortcut once a
  session is bound or has been created.
- Expiry: 1 day, 7 days, a custom number of days, or permanent. Saving enables
  the rule unless its enabled switch is off. Pausing works while the Runner is
  offline. Editing does not automatically renew an existing expiry.
- Private-network access is off by default. Explicitly enabling it allows
  access from the Hub to its local/private services. Cloud metadata,
  link-local, multicast and unspecified addresses remain blocked.
- GET and HEAD are preferred. Repeating POST can modify a service: it requires
  a separate explicit opt-in. No redirect following, file reads, shell
  substitutions, pipes, proxy options, multipart uploads or TLS bypass.

## Receive a webhook

New tokens are stored as AES-256-GCM ciphertext, separately from their lookup hash.
Only the monitor owner's authenticated API can retrieve a token. Events offers
copy-URL and copy-cURL buttons; the creation result also supports both.
Tokens are masked on screen and are not persisted in browser storage.
Existing hash-only tokens remain valid but cannot be retrieved: explicitly rotate
once to enable copying. Rotation invalidates the old token, without extending expiry.

```sh
curl -X POST 'https://your-hub.example/hooks/events?token=YOUR_RULE_TOKEN' \
  -H 'Content-Type: application/json' \
  --data-raw '{"prompt":"API returned HTTP 500"}'
```

GET/HEAD cannot trigger work (405). Only the query parameter `token` and JSON
field `prompt` are accepted. The sender cannot change directory, model, permissions
or owner instructions. Prompt is untrusted evidence, not repair authorization.

Response `202 {"accepted":true,"duplicate":false}` means saved, not completed.
Identical prompts within one minute are deduplicated; events coalesce into the
currently open incident. Unknown, paused or expired tokens return 503; invalid
JSON or oversized input returns 400; rate limits return 429 with Retry-After.
Limits: 8,000 prompt characters, 32 KiB body, 10 new events/minute/rule and
2,000 events over seven days/rule.

Hub excludes /hooks/ from request logs and disables caching. Configure your proxy
to omit query strings for this path. URLs and copied cURL commands contain credentials.

Back up `<DB_PATH>.monitor-key` securely alongside (but separately from) database
backups. Its permissions are 0600. Missing/corrupt keys disable token retrieval
rather than silently replacing existing keys; token hash authentication still works.
The database schema is upgraded to version 21. An older binary may require
restoring its corresponding database backup.

List cards offer an enable switch and swipe-left Delete with confirmation;
the ordinary Delete icon is also available. Deletion removes the rule, token,
metrics and event records, not agent sessions or work already delivered.
Webhook/Scheduled screens show trigger information, not service uptime.

## Investigation and approval

1. Webhooks queue an investigation immediately. HTTP checks require **two
   consecutive failures** before queuing one. A successful check resets this
   streak. Current health and incident workflow are independent: a service can
   recover while a repair proposal still awaits review.
2. SHAPI creates a separate managed investigation session. Codex starts in
   **Read Only**; Claude starts in **Plan**. A missing directory is not created
   automatically. Evidence is explicitly marked as untrusted input.
   Bound rules instead use their source session: managed sessions wait while
   busy and require **Read Only** (Codex) or **Plan** (Claude) before investigation;
   SHAPI does not change the source's permissions automatically. Native Codex uses the
   verified read-only review delivery lane. Native staging uses the existing
   Runner feedback-file store; it is not removed by the seven-day metric prune.
3. Only an assistant-authored final response followed by a successful provider
   turn outcome becomes the displayed proposal. Idle/ready alone is not proof
   of success. Interrupted or failed sessions require attention instead.
4. Review the exact stored Markdown proposal, then explicitly confirm repair.
   SHAPI binds confirmation to its hash and the original configuration snapshot.
   Repeated taps cannot create another repair session. The separate repair
   session uses the permission mode you configured; it does not auto-approve
   agent permission requests.
   For a bound rule, the approved plan is sent back to the same source session.
   The latest monitor prompt and final proposal are checked again immediately
   before delivery. If the conversation changed, repair is stopped for inspection.
   This check is not an atomic lock across Desktop and Hub: do not submit another
   Desktop task while confirming a bound repair. A concurrent Desktop turn can
   still race the final check and native queue acceptance.
5. Review the result in the linked session. "Repair session completed" means
   the agent finished, not that the service is healthy: HTTP health is measured
   independently. Stop a running session in the normal session UI before
   closing its incident.
   A source that remains missing or whose result cannot be matched for five
   minutes becomes `needs_attention`; this releases scheduling capacity without
   claiming delivery failed or automatically sending the message again.

Read-only/plan modes and the owner-approval workflow do not replace host-level
security boundaries. Install only trusted agent tools/MCP servers and restrict
their credentials: a filesystem sandbox is not a universal sandbox for remote
tools or external APIs.

If Hub loses contact while creating a session, it records **Needs attention**
instead of automatically retrying an uncertain operation. Inspect the linked
session or session list before closing the incident. Queued, not-yet-dispatched
events survive restart. Paused/expired rules do not dispatch queued work; they
do not kill an already-running session.

Push notifications use the existing PWA subscription and link to the rule's
detail page. Subscribe in SHAPI and grant notification permission on your
device. Notification delivery does not determine whether an event was saved.

### Optional Bark

Each monitor has a **Push notifications** switch in its create/edit form.
It defaults to on (including existing rules). Turning it off suppresses that
monitor's Bark and browser pushes without pausing checks, schedules or agent
investigation. It does not suppress ordinary session notifications. Changing
only this switch works while the Runner is offline and preserves the next run.
Already-sent notifications cannot be recalled.

Monitor pushes cover a new queued incident, probe failure/recovery, dispatch
needing attention, a proposal ready for approval, and a completed repair turn.
Routine successful probes and repeated triggers coalesced into an open incident
do not each generate another Monitor push. Tapping opens that monitor's detail.

In basic Web settings, paste the full Bark URL copied from the Bark app. The
current integration supports the official HTTPS `api.day.app` host. Sample
title/body path components are discarded. The device key is stored only in the
protected Hub database, scoped to the signed-in namespace, and never returned
by the settings API. Empty/disabled configuration sends no Bark requests.
Existing notification events are also delivered through Bark; a configured
Hub public URL supplies the deep link. Requests use the official JSON POST API,
have a five-second timeout, and do not follow redirects. Saving configuration
does not send a test notification. See [Bark documentation](https://github.com/Finb/Bark/blob/master/README.md).

## Seven-day history and resource limits

- Slim status bars aggregate actual observations into hourly buckets. Gray
  means no sample, not 100% availability. HTTP percentages are successful
  checks divided by observed checks, **not time-weighted SLA uptime**.
- Webhook bars count accepted distinct events; quiet hours do not establish
  service availability. SHAPI cannot calculate rejection rate for invalid
  tokens because they cannot be safely attributed to a rule.
- Response latency is measured per observed check. Responses are discarded;
  optional text matching reads at most 128 KB. Request timeouts are 1–30 seconds.
- The background scheduler is bounded: four probes and two session dispatches
  per cycle; no overlapping cycles or catch-up bursts after downtime. Requested
  intervals are best-effort; slow endpoints or a saturated queue delay checks.
- At most four active automatic agent sessions globally, two per namespace;
  excess incidents remain queued. A rule has at most one open incident.
- Up to 50 rules per namespace, 200 globally. Hourly housekeeping retains seven
  days of metrics/receipts and closed incidents, with at most 100 closed incidents per rule,
  2,000 globally. Open incidents are retained until handled. Referenced agent
  sessions follow the existing session retention policy, not metric cleanup.
- UI queries run only on visible mounted monitor pages, not session detail
  pages. No new chart library or permanent transcript polling is introduced.

Configuration headers and any provided evidence live in the existing protected
Hub SQLite database. Do not commit that database, tokens, backups or diagnostic
payloads. Incident snapshots do not duplicate probe headers/bodies.

## Upgrade

Upgrade Hub, Web and Runner together. Store schema V19 adds monitor tables and
V20 adds namespace-scoped Bark settings,
without rewriting sessions. Back up the database before production migration;
older binaries that only understand V18 cannot open the upgraded database.
Restore a matching database backup as well as the binary to roll back.

No production rules, credential issuance or probes are enabled during local
development tests. The browser fixture uses clearly separated sample data.
