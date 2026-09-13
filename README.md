# 🤖 AI Worker

Feed it a project. Come back to working code.

A self-hosted workshop for Claude Code and Codex. Queue a brief, let the workers
build, and follow the whole thing from your browser—even after you close it.

[Install](INSTALL.md) · [Use it](HOWTOUSE.md) · [Operations](docs/OPERATIONS.md) · [THUGS(red)](https://thugs.red)

<p align="center">
  <img src="html/assets/banner.png" alt="A mint robot cat tending an autonomous coding workshop" width="720">
</p>

## ⚡ Put it to work

```sh
git clone https://github.com/kawaiipantsu/aiworker.git
cd aiworker
```

Follow **[INSTALL.md](INSTALL.md)** for the complete Debian setup: packages,
service accounts, database creation and seeding, provider login, HTTPS, and
background services. The bootstrap generates unique credentials locally; no
working passwords or provider accounts ship with the repository.

## 🛠️ From brief to build

| You bring | AI Worker handles |
| --- | --- |
| A name and a clear prompt | A dedicated project workspace and persistent job history |
| Claude Code or Codex access | Separate queues, concurrency limits, and provider cooldowns |
| Existing code | ZIP uploads, public ZIP URLs, or a clean start |
| A change of direction | Queued messages, questions, pause/resume, and interrupt & steer |
| Absolutely no idea | “I feel lucky” generates an editable brief and optional starter files |
| A finished workload | Completion summaries, searchable history, CSV and PDF reports |

Optional Discord webhooks announce workload state changes. Administration manages
users, models, concurrency, provider retries, and cancelled-project retention.

## 💻 Use it

1. Sign in with the locally generated administrator credentials and change the password.
2. Choose **New project / workload**, describe the result, and select a provider and model.
3. Attach starter code if needed, then create the workload.
4. Follow progress, answer questions, and review the output in `/srv/projects/<slug>/`.

The browser is the dashboard. Systemd keeps the workers running.
See **[HOWTOUSE.md](HOWTOUSE.md)** for your first project.

## 🧱 Under the hood

PHP 8.4 + Apache/PHP-FPM serve the dashboard. Node.js runs the workers. MariaDB
holds durable application data, Redis handles sessions and health signals, and
Beanstalkd carries queue tickets. No frontend build step.

This is a tool for trusted operators: workloads execute code as the worker OS
account, and operators share project access. Use a dedicated host and read the
[security boundaries](docs/SECURITY.md) before granting access.

```sh
npm ci --prefix worker
npm test --prefix worker
```

[Installation](INSTALL.md) · [Usage](HOWTOUSE.md) · [Maintenance](docs/OPERATIONS.md) · [THUGS(red)](https://thugs.red)
