# Security boundaries

This is a private operations tool: an operator can submit arbitrary instructions to a full-access AI CLI. Give accounts only to people trusted to run code as the worker OS account. All operators share the project overview and can control all workloads. Administrators additionally manage users, model lists, concurrency, webhook destinations and audit visibility. There is no per-project tenant isolation.

Apache's document root is only `html/`. Parent paths are denied by vhost configuration. `.htaccess` disables directory listings, denies dotfiles and backend path names, restricts executable PHP entry points, and sets CSP, frame denial, MIME sniffing protection and referrer policy. Static assets are public; API data requires authentication. Application code and public files are root-owned; PHP cannot write there. A dedicated PHP-FPM pool disables shell execution and restricts filesystem access. The web account cannot read the worker's provider credentials.

Serve HTTPS directly or terminate TLS at a trusted upstream proxy with a private HTTP origin on port 8080. Session cookies are always Secure, HttpOnly and SameSite=Strict; the application does not infer security from arbitrary forwarded headers. Plain HTTP browser login is incompatible with Secure cookies. Configure Apache remote-IP handling only for explicitly trusted proxies; see INSTALL.md.

Passwords use Argon2id. Login sessions rotate on authentication, expire after eight hours of inactivity and are checked against account state and session version on every request. Password changes, resets, disabled accounts and role edits revoke sessions. Redis login throttles apply per IP and normalized username. All mutations require a session CSRF token. SQL uses bound parameters. UI data and worker logs are escaped/rendered as text. There are no external script/font dependencies.

ZIP limits: 32 MiB compressed, 256 MiB expanded, at most 10,000 entries, and compression-ratio checks for large entries. Absolute paths, traversal, Windows drive paths, backslashes, symlinks and special device/FIFO entries are rejected. Extraction uses new files only and checks path components. Uploaded project code remains trusted executable workload input; file validation does not make arbitrary source code safe.

Discord webhook destinations are restricted to exact HTTPS `discord.com/api/webhooks/<id>/<token>` paths. Redirects are refused, requests time out, and mention parsing is disabled. URLs are never returned by admin APIs or included in normal audit entries. Notifications contain project name, state and a dashboard link, not prompts or output. Delivery occurs only for enabled, explicitly configured destinations. Known API-key patterns and the configured DB password are redacted from output logging; arbitrary secrets printed by workload code cannot be comprehensively detected.

Bootstrap DB credentials remain in `etc/config.json`, mode 0640, shared only by the dedicated web and worker groups. Provider credentials are mode 0600 in the worker home. Initial admin credentials and backups are private, outside `html/`, and excluded from git. All mutable application data lives in MariaDB except Redis session/ephemeral state and filesystem project/provider-session artifacts.

Audit events are durable application records, not cryptographically tamper-proof: the DB account and a full-access workload with that account's readable configuration can modify them. Strong hostile-workload isolation would require separate hosts/containers, scoped service identities and an external audit sink. The application uses autonomous execution under shared service accounts.


The idea generator has separate encrypted credentials and a dedicated restricted systemd account. Its encryption key is outside the database and not readable by the project-worker account. Admin-only credential APIs never return saved tokens; revision checks prevent cancelled or obsolete login requests from overwriting a newer connection. Provider JSON and starter paths are validated before packaging or rendering. ZIP URL imports pin public DNS resolutions and reject private addresses and unsafe redirects to prevent server-side request forgery. Details and backup-key requirements are in OPERATIONS.md.

## Project deletion and reports

Cancellation deletion and retention policy mutations require administrator access plus CSRF validation. Status transitions use row locks; deletion state blocks resume, messages and answers. The unprivileged retention service uses a constrained project slug and descriptor-based recursive deletion that does not traverse symlinks. It deletes relational history only after removing the workspace successfully, preserving audit records. Existing backups retain their contents until separately removed by their backup policy.

Completed exports require authentication and are audited. CSV guards against spreadsheet formula injection; PDF text is escaped before markup rendering and uses local fonts without remote content. Reports contain project metadata and completion summaries, not credentials or prompts.
