# Your first AI Worker project

Complete [INSTALL.md](INSTALL.md), authenticate the provider you want to use,
and open your HTTPS dashboard. Sign in with the credentials generated in the
private `docs/ADMIN_CREDS.md`, then change the password under **Account**.

## 1. Write a brief

Choose **New project / workload**. Give it a descriptive name and a prompt that
states what to build, constraints, and how success should be tested. For example:

```text
Build a small static task board using HTML, CSS, and vanilla JavaScript.
Support adding, completing, and removing tasks, and persist them in localStorage.
Make it usable on mobile and with a keyboard. Add a README with run instructions.
Test the key interactions and report what passed and any remaining limitations.
Do not deploy it or connect external services.
```

Choose **Codex** or **Claude**, a model available to your account, and a thinking
level. **Auto** uses the provider's automatic permission handling; **YOLO / bypass**
allows unrestricted provider tool execution within the worker account's OS
permissions. Subagents enable delegation. Dynamic workload asks the worker to
maintain and complete a living `docs/TASKS.md` task list.

## 2. Bring code—or start empty

Leave starter files empty for a new project, upload a ZIP, or provide a public
HTTP/HTTPS ZIP URL. ZIP URLs cannot use private-network addresses or embedded
credentials. Keep secrets, `.env` files, provider logins, and private keys out of
scaffolds and prompts. Archives are limited to 32 MiB compressed and 256 MiB
expanded; traversal paths and symlinks are rejected.

If the OpenAI idea generator is configured in **Administration**, **I feel lucky**
creates an editable brief. Its starter-files option can also generate a ZIP.
Review the name, prompt, and worker choices before submitting. Idea generation
uses provider quota; it does not create a workload until you click **Create**.

## 3. Create and follow along

Click **Create**. The workload enters the queue and gets a unique workspace at
`/srv/projects/<slug>/`. The worker writes `docs/INIT_PROMPT.md` and
`docs/WORKLOAD_DETAILS.md` there before starting. Install any additional language
runtimes or build tools your projects require on the worker host.

Open the project to inspect status, progress, output, and questions. Answer a
question in the dashboard when the worker needs input. **Queue message** saves
instructions for its next inbox check or turn. **Interrupt & steer** stops the
current process and resumes its conversation with your new instructions.

**Pause** frees its execution slot; **Resume** continues in the same workspace.
**Cancel** stops the workload while retaining its files and history. You can close
the browser: the background services keep working.

## 4. Review the result

Use **Completed**, **Cancelled / failed**, or **All history** to find older work.
Review the summary and validation evidence, then inspect the project files on the
server. Completion is the worker's report; verify the output before deploying it.
There is no automatic deployment step. The Completed view can export matching
projects as CSV or a PDF report.

Administrators can delete cancelled projects or enable automatic cancellation
cleanup. Deletion removes the workspace and related job data; backups have their
own retention policy. Cleanup is off by default.

## When something waits or fails

- **Queued:** check dispatch pause, provider concurrency, and service health.
- **Provider cooldown:** restore account access/quota, then use **Retry provider now**.
- **Authentication failure:** renew the worker account's CLI login; dashboard login is separate.
- **Unknown model or option:** choose an available model and check installed CLI compatibility.
- **Login will not stick:** access the dashboard over HTTPS; cookies require it.

See [operations](docs/OPERATIONS.md) for recovery, backups, password resets,
notifications, and service commands.
