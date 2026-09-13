# Operations

## Starting workloads

Sign in, select New project / workload, and provide a name and prompt. “I feel lucky” fills the same form using the configured OpenAI connection and the fixed gpt-5.6-terra model. Generating an idea consumes provider usage, but no project workload is submitted until Create is clicked.

Names are transliterated into readable slugs with a random suffix to avoid collisions. The dispatcher creates `/srv/projects/<slug>` and always launches and resumes the provider with that directory as `cwd`. ZIPs are validated twice and extracted to a staging directory before it is renamed into place. Both generated documents are written before execution. A supplied `docs/INIT_PROMPT.md` or `docs/WORKLOAD_DETAILS.md` is replaced by the authoritative workload data.

Codex and Claude have independent concurrency settings, each with a minimum of one and maximum of sixteen. With defaults, one Codex and one Claude run together. There is no global slot that would force the two providers to wait on each other. A provider cooldown blocks only that provider. Pause dispatch in Administration to stop new launches while existing runs finish.

## Modes and models

- YOLO / bypass: Codex `--dangerously-bypass-approvals-and-sandbox`; Claude `--dangerously-skip-permissions`.
- Auto: Codex automatic approval review on new and resumed sessions; Claude `--permission-mode auto --permission-prompts none`. Provider denials can prevent work in Auto; use the full-access modes for workloads requiring unrestricted CLI tool execution.
- Claude subagents: enabled by permitting Agent and setting its experimental agent-team environment flag. Disabled workloads deny Agent. Codex uses `features.multi_agent`.
- Dynamic workload: Claude receives instructions to maintain `docs/TASKS.md`, expand discovered tasks and complete them. This is a prompt workflow, not a CLI extension.
- Models are editable in Administration. Seeded model choices are defaults; select models available to your account. `php contrib/sync-models.php /path/to/models_cache.json` refreshes them. Claude accepts provider aliases `sonnet`, `opus`, `fable`; availability and supported effort depend on the subscription and model. CLI validation failures appear in job output.

No program can restore account funds or guarantee provider availability. A rejected rate/usage/credit limit schedules provider-specific retry. Structured reset timestamps and retry-after values are honored when present; otherwise retries back off from the configured base to six hours. Reset delays can extend further when explicitly reported. Successful workload completion resets consecutive limit attempts. “Retry provider now” clears cooldowns after credits or access are restored. Authentication failures need a renewed CLI login; they are shown as failed workloads, not silently retried forever.

## Questions, steering and completion

The worker receives dashboard instructions automatically. It uses:

```sh
/opt/aiworker/bin/workload status "Short progress update"
/opt/aiworker/bin/workload inbox
/opt/aiworker/bin/workload ask "One essential question"
```

The job ID comes from its environment. `ask` stores a question in MariaDB and waits for the website answer. Answering can unblock the running helper or resume an ended session. Questions returned in a provider's structured blocked outcome are also persisted.

Queue message adds a persistent instruction. A cooperative worker reads it with `inbox`; otherwise it is supplied at the next provider turn. Interrupt & steer terminates the current process group and resumes the stored conversation with pending instructions. It is not a native, in-place edit of a running model turn. A terminal command already executed cannot be undone by interruption. Pause releases the provider slot; Resume starts a new CLI process in the same workspace using the saved provider session. Cancel stops the run and retains files and history.

The provider must emit a structured outcome: completed, blocked or failed, with a summary. Exit code zero alone is insufficient for completion. Execution errors and missing reports are recorded as failed. The outcome is the agent's report, so review its validation evidence and resulting artifacts.

On restart, systemd terminates the service's process group, and the dispatcher requeues interrupted jobs while respecting pending pause/cancel requests. MariaDB advisory locking prevents two dispatchers sharing this database. Beanstalkd carries small job IDs; settings and prompts are loaded from MariaDB immediately before execution. Database records recover dropped or expired queue tickets. Queue, Redis and DB failures are reflected in the header and journal.

## Services and credentials

The installation guide uses:

- `/etc/apache2/sites-available/aiworker.conf`.
- `/etc/php/8.4/fpm/pool.d/aiworker.conf` (dedicated web pool).
- `/etc/systemd/system/aiworker.service`.
- `/opt/aiworker/bin/codex`, its `codex-code-mode-host` companion, and `claude`.

Worker OS account: `aiworker`, home `/var/lib/aiworker`. Web PHP account: `aiworker-web`. CLI full-access flags remove provider sandbox/approval gates; Linux permissions still apply. The worker can create and manage its `/srv/projects` workspaces. It has not been granted root or passwordless sudo access to unrelated services.

Authenticate directly as the worker account following INSTALL.md. If using the optional credential-copy helper, source and worker authentication copies are independent; rotation may require re-synchronization. Never place tokens in the web root or paste them into workloads.

`contrib/update-clis.sh` is an optional helper for an existing standalone root CLI installation, including Codex's companion host. For the npm installation in INSTALL.md, update the complete packages in `/opt/aiworker` instead. Recheck CLI capabilities and smoke tests after upgrades.

## Backups and maintenance

`node contrib/backup.mjs` writes a consistent MariaDB SQL snapshot with mode 0600 under `var/backups`. It includes users, upload blobs, audit history, settings and webhook secrets. Protect these files accordingly. `contrib/systemd/aiworker-backup.timer` provides a daily backup schedule. Project source trees and `/var/lib/aiworker` need inclusion in the host's filesystem backup policy; database backups alone do not include generated project files or provider session files.

Restore is explicit and replaces the configured database:

```sh
systemctl stop aiworker
# Block web writes / place the vhost in maintenance before proceeding.
node contrib/restore.mjs --replace-database /path/to/backup.sql
systemctl start aiworker
```

`php contrib/cleanup.php` reports eligible log events without deleting anything. `--apply --days=90` removes only old output events for terminal jobs, retains audit history, and records maintenance in the audit log. It never deletes project directories. The cron example is not enabled automatically. Backups are not automatically pruned; move snapshots to your backup storage and apply a retention policy suitable for your projects.

`php contrib/reset-password.php admin` generates a new password, revokes existing sessions and writes private credentials to `docs/ADMIN_CREDS.md`. Never run the initial installer to reset an existing password; it deliberately leaves existing accounts unchanged.

## Provider documentation

Implemented against installed Codex 0.154.0 and Claude Code 2.1.269 and checked against the official [Codex non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode) and [Claude CLI reference](https://code.claude.com/docs/en/cli-reference). Local CLI help is authoritative for the installed command-line surface.

## OpenAI ideas and saved credentials

Administration → OpenAI idea generator supports two independent authentication methods:

- **Sign in with OpenAI** starts the official Codex device-code authorization flow. Open the official `auth.openai.com` link shown in the page, enter the one-time code, and authorize the account. The page stores the resulting session after authorization. Device-code authorization may need to be enabled in the account's ChatGPT security settings.
- **Save API key** stores an OpenAI API key. The key is never returned to the browser; only its last four characters are shown. API usage is billed to the API account.

The generator model is fixed in server code to `gpt-5.6-terra`; editing the project worker model catalog cannot change it. ChatGPT-account requests use the installed Codex client, while API keys use the official Responses API with strict JSON output. Neither path silently substitutes another model. Account access and usage limits still apply. Test connection sends a small request to this exact model and records the successful check time or an actionable error.

New installations have no OpenAI connection. Configure an account or key in the admin page. Reset removes the active stored generator credential, cancels pending login/generation operations, and increments the connection revision so an older in-flight request cannot restore the removed credential. It does not revoke an API key at OpenAI or log out the separate project worker account. Existing database backups can contain older encrypted credential records.

Credential blobs use AES-256-GCM with a random nonce and authenticated application context, stored in the `openai_connection` table. The encryption key is `etc/secrets.key`, mode 0640, readable only by root and the `aiworker-credentials` group (web and idea-service accounts). Back up this key separately and securely: a restored database cannot decrypt saved credentials without it. Never put the key in git or the web root. Project worker accounts are not members of that credential group.

`aiworker-ideas.service` runs as `aiworker-ideas`, separately from project workers, with a read-only system filesystem and a private writable home. OAuth auth-cache files exist only in private per-request runtime directories and are removed after each request; refreshed sessions are encrypted back into the DB. Startup cleans abandoned runtime directories. No raw provider output or credentials are written to application logs. The service has its own database lock, generation queue and Redis heartbeat, so creating ideas does not occupy either provider's project-workload slot.

```sh
systemctl status aiworker-ideas
journalctl -u aiworker-ideas -f
# Optional, root-only import from an already authenticated Codex account:
php contrib/import-idea-login.php /private/path/to/auth.json
```

“I feel lucky” randomly selects from the requested security/defence, games, DevOps, analysis, forensic, networking, creative and music categories. The server prompt requests a distinctive, feasible MVP, Linux-compatible build/setup, an actionable brief, testing and acceptance criteria. It receives validated JSON containing name, summary, project type, initial prompt, worker recommendations and optional starter-file contents. The full JSON is available for inspection in the project dialog.

The **Starter files** checkbox requests optional scaffolding. Safe relative text files are packaged into a ZIP by the server, not downloaded from an invented model URL. The dialog lists the files and lets you download the ZIP, use it, replace it with an upload/URL, or choose no scaffolding. Creating a workload consumes the draft once; aborting the preview cancels it. No workload is started just by generating or previewing an idea. Generation can be cancelled from its loading dialog, and errors remain visible. Each user is limited to 20 requests/hour and one pending request; the global queue holds at most eight requests. Normal generation has a three-minute runtime timeout.

## ZIP URLs

New workloads support either an uploaded ZIP, a public HTTP/HTTPS ZIP URL, generated starter files, or no scaffold. URL download happens on Create, with progress indicated on the button. Files are stored in the same `uploads` database table and follow the existing validated extraction process.

URL imports use standard ports, reject embedded credentials and fragments, resolve and validate all destination IPs, pin the selected public address for the HTTP connection, and revalidate every redirect. Private/reserved addresses, local-only hostnames, HTTPS-to-HTTP redirects and non-HTTP schemes are refused. Downloads are limited to 32 MiB, four redirects and a bounded request time. An external URL does not need to end in `.zip`, but its downloaded content must be a valid, safe ZIP archive. No authentication headers or application cookies are forwarded to the remote server.

## Active workloads and history

The default **Active** tab excludes completed, cancelled and failed workloads. **Completed**, **Cancelled / failed**, and **All history** provide separate views of the same persistent `jobs` table. They are filters, not a destructive move to another table. Search and provider/status filters work within those views. Clicking a historical workload opens its original status, prompt, settings, questions and logs; Resume or a new follow-up prompt returns it to active work.

Completed and failed projects remain indefinitely. An administrator can open a cancelled project and choose **Delete project**. Confirmation explains that its workspace, uploaded scaffold, prompt/settings record, messages, questions and logs will be permanently removed. Audit events remain, and existing backups are unaffected. Deletion is queued and normally runs within one minute. Projects being deleted cannot be resumed or receive new messages/answers.

Administration → **Cancelled project cleanup** provides a separate automatic-deletion switch and a retention period of 1–3650 days (default 30). The switch is off by default. Enabling it also applies to existing cancelled projects older than the selected period. Age is measured from cancellation (`finished_at`), with `updated_at` as a fallback for older records without a finish timestamp. Completed, failed and active jobs are excluded. Changing the policy does not undo deletions already requested.

`aiworker-retention.timer` checks every minute and runs `contrib/project-retention.php --apply` as the unprivileged worker account. It handles manual requests even while automatic cleanup is disabled. `php contrib/project-retention.php` reports eligible projects without deleting anything. The remover is limited to direct `/srv/projects/<slug>` directories and uses Python's file-descriptor-based, symlink-resistant removal. Filesystem removal must succeed before the database record is deleted. Failures retain the deletion state for retry and add a `job.delete_failed` audit event; check file permissions and `journalctl -u aiworker-retention.service`. Workloads marked for deletion are excluded from Active.

The existing optional `contrib/cleanup.php` output-log cleanup remains separate; it never removes project workspaces.

## Completed CSV and PDF exports

In **Completed**, choose **Export CSV** or **Download PDF report**. Both include every completed project matching the current search and provider filter, across all pages, ordered by completion date. CSV includes IDs, names, slugs, providers, models, creation/start/completion timestamps, result summaries and workspace paths. UTF-8 CSV has an Excel-compatible BOM, quoted fields and formula-injection protection. The PDF provides a paginated overview with project names, provider/model, dates, workspace paths, result summaries and page numbers. All export dates are UTC.

Both downloads require an authenticated account and are audited. No prompts, credentials or raw worker logs are included. Empty results produce a CSV header or an explanatory PDF. PDF generation uses Debian's `php-tcpdf` package (`apt-get install php-tcpdf`); Python 3 is required for workspace deletion. Neither process contacts an external reporting service.

Official references: [Codex authentication and device-code sign-in](https://learn.chatgpt.com/docs/auth), [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [structured Responses output](https://developers.openai.com/api/docs/guides/structured-outputs).
