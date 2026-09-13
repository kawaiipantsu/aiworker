"use strict";
const $ = (s, r = document) => r.querySelector(s),
  $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let workloadView = "active",
  jobsRequest = 0;
let me = null,
  csrf = "",
  catalog = null,
  page = 1,
  routeToken = 0,
  lastEvent = 0,
  detailId = 0,
  refreshing = false;
const date = (v) =>
  v ? new Date(v.replace(" ", "T") + "Z").toLocaleString() : "—";
const badge = (s) =>
  `<span class="badge ${esc(s)}">${esc(s.replaceAll("_", " "))}</span>`;
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").style.display = "block";
  setTimeout(() => ($("#toast").style.display = "none"), 4000);
}
async function api(action, data, extra = "") {
  const opt = { headers: { "X-CSRF-Token": csrf } };
  if (data !== undefined) {
    opt.method = "POST";
    if (data instanceof FormData) opt.body = data;
    else {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(data);
    }
  }
  const response = await fetch("/api.php?action=" + action + extra, opt);
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && action !== "login") {
      me = null;
      loginView();
    }
    throw new Error(body.error || "Request failed");
  }
  return body;
}
function safe(fn) {
  return async (e) => {
    try {
      await fn(e);
    } catch (err) {
      toast(err.message);
    }
  };
}
function formData(form) {
  return Object.fromEntries(new FormData(form));
}
function loginView() {
  detailId = 0;
  $("#health").textContent = "Private workspace";
  $("#admin-link").classList.add("hidden");
  $("#logout").classList.add("hidden");
  $("#account-button").classList.add("hidden");
  $("#main").innerHTML =
    `<section class="login-layout"><div class="login-art"><span class="eyebrow">YOUR IDEAS, IN GOOD HANDS</span><h1>A little spark.<br>A lot of possibility.</h1><p>Your autonomous coding workshop.<br>Powered by Claude & Codex.</p></div><div class="login-box"><span class="eyebrow">WELCOME TO THE WORKSHOP</span><h2>Let’s get to work.</h2><p class="muted">Sign in to manage your projects and workers.</p><form id="login-form"><label>Username<input name="username" autocomplete="username" required autofocus></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><p class="form-error"></p><button class="primary">Sign in →</button></form><p class="hint">Private workspace · Authorized users only</p></div></section>`;
  $("#login-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    $("button", f).disabled = true;
    try {
      await api("login", formData(f));
      await boot();
    } catch (err) {
      $(".form-error", f).textContent = err.message;
    } finally {
      $("button", f).disabled = false;
    }
  };
}
async function boot() {
  try {
    const s = await api("session");
    csrf = s.csrf;
    me = s.user;
    if (!me) return loginView();
    $("#admin-link").classList.toggle("hidden", me.role !== "admin");
    $("#logout").classList.remove("hidden");
    $("#account-button").classList.remove("hidden");
    catalog = await api("catalog");
    await route();
    await health();
  } catch (err) {
    $("#main").innerHTML =
      `<div class="notice">${esc(err.message)} <button id="reconnect" class="secondary">Reconnect</button></div>`;
    $("#reconnect").onclick = boot;
  }
}
async function route() {
  routeToken++;
  detailId = 0;
  const hash = location.hash;
  if (hash === "#admin" && me?.role === "admin") return adminView();
  const match = hash.match(/^#job\/(\d+)$/);
  if (match) return detailView(Number(match[1]));
  return overview();
}
async function health() {
  if (!me) return;
  try {
    const h = await api("health");
    $("#health").textContent = h.worker
      ? h.paused
        ? "Dispatch paused"
        : h.queue
          ? "Systems operational"
          : "Queue reconnecting"
      : "Worker offline";
    if ($("#service-notice")) {
      $("#service-notice").innerHTML = !h.worker
        ? '<div class="notice">The worker service is offline. Workloads remain safely queued in the database.</div>'
        : h.paused
          ? '<div class="notice">Dispatch is paused by an administrator.</div>'
          : "";
    }
  } catch {
    $("#health").textContent = "Service unavailable";
  }
}
async function overview() {
  page = 1;
  $("#main").innerHTML =
    `<div class="page-head"><div><span class="eyebrow">MISSION CONTROL</span><h1>Your workloads</h1><span class="muted">An idea, a prompt, and a worker. Take it from here.</span></div><div class="actions"><label class="lucky-option"><input type="checkbox" id="lucky-scaffold" checked> Starter files</label><button id="lucky" class="secondary">✦ &nbsp; I feel lucky</button><button id="new" class="primary">＋ &nbsp; New project / workload</button></div></div><div id="service-notice"></div><section class="stats" id="stats"></section><section class="workspace"><div class="workload-views" role="group" aria-label="Workload views"><button data-view="active" class="view-tab">Active</button><button data-view="completed" class="view-tab">Completed</button><button data-view="closed" class="view-tab">Cancelled / failed</button><button data-view="all" class="view-tab">All history</button><span class="hint">Completed projects are retained. Cancelled project cleanup is managed in Administration.</span></div><div class="toolbar"><input id="search" type="search" placeholder="Search workloads or projects…" aria-label="Search workloads"><select id="status-filter" aria-label="Filter status"><option value="">All statuses</option>${["queued", "preparing", "running", "waiting_input", "rate_limited", "paused", "completed", "failed", "cancelled"].map((s) => `<option value="${s}">${s.replaceAll("_", " ")}</option>`).join("")}</select><select id="provider-filter" aria-label="Filter provider"><option value="">All workers</option><option value="codex">Codex</option><option value="claude">Claude</option></select></div><div id="completed-exports" class="actions completed-exports hidden"><a class="secondary" id="export-csv">Export CSV ↓</a><a class="secondary" id="export-pdf">Download PDF report ↓</a><span class="hint">All completed projects matching your filters, across all pages.</span></div><div class="table-wrap"><table><thead><tr><th>Project / workload</th><th>Status</th><th>AI worker</th><th>Model</th><th>Updated</th><th></th></tr></thead><tbody id="jobs-body"></tbody></table></div><div class="table-foot"><span id="total"></span><div><button id="previous" class="subtle">← Previous</button><span id="page"></span><button id="next" class="subtle">Next →</button></div></div></section>`;
  $("#new").onclick = () => project();
  $("#lucky").onclick = () => OpenAIUI.generate();
  $$("[data-view]").forEach(
    (b) =>
      (b.onclick = safe(async () => {
        workloadView = b.dataset.view;
        page = 1;
        $("#status-filter").value = "";
        await loadJobs();
      })),
  );
  let timeout;
  $("#search").oninput = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      page = 1;
      loadJobs().catch((e) => toast(e.message));
    }, 250);
  };
  for (const f of ["status-filter", "provider-filter"])
    $("#" + f).onchange = safe(() => {
      page = 1;
      if (f === "status-filter" && $("#status-filter").value) {
        const status = $("#status-filter").value;
        workloadView =
          status === "completed"
            ? "completed"
            : ["cancelled", "failed"].includes(status)
              ? "closed"
              : "active";
      }
      return loadJobs();
    });
  $("#previous").onclick = safe(() => {
    page--;
    return loadJobs();
  });
  $("#next").onclick = safe(() => {
    page++;
    return loadJobs();
  });
  await loadJobs();
}
async function loadJobs() {
  if (!$("#jobs-body")) return;
  const token = routeToken,
    request = ++jobsRequest,
    params = new URLSearchParams({
      view: workloadView,
      search: $("#search").value,
      status: $("#status-filter").value,
      provider: $("#provider-filter").value,
      page,
    });
  const d = await api("jobs", undefined, "&" + params);
  if (token !== routeToken || request !== jobsRequest) return;
  $$("[data-view]").forEach((b) => {
    b.classList.toggle("selected", b.dataset.view === workloadView);
    b.setAttribute("aria-pressed", String(b.dataset.view === workloadView));
  });
  $("#completed-exports").classList.toggle(
    "hidden",
    workloadView !== "completed",
  );
  for (const format of ["csv", "pdf"]) {
    const exportParams = new URLSearchParams({
      action: "completed_export",
      format,
      search: $("#search").value,
      provider: $("#provider-filter").value,
    });
    $("#export-" + format).href = "/api.php?" + exportParams;
  }
  const counts = Object.fromEntries(
    d.counts.map((c) => [c.status, Number(c.n)]),
  );
  const total = d.counts.reduce((n, c) => n + Number(c.n), 0);
  $("#stats").innerHTML = [
    ["▦", "Total workloads", total],
    ["↗", "In progress", (counts.running || 0) + (counts.preparing || 0)],
    ["◷", "In the queue", (counts.queued || 0) + (counts.rate_limited || 0)],
    ["✓", "Completed", counts.completed || 0],
  ]
    .map(
      ([icon, label, n]) =>
        `<div class="stat"><div><i>${icon}</i><span class="stat-label">${label}</span></div><strong>${n.toLocaleString()}</strong></div>`,
    )
    .join("");
  $("#jobs-body").innerHTML = d.jobs.length
    ? d.jobs
        .map(
          (j) =>
            `<tr class="job-row" data-job="${j.id}" tabindex="0"><td><a class="job-name" href="#job/${j.id}">${esc(j.name)}</a><span class="job-path">/srv/projects/${esc(j.slug)}</span></td><td>${badge(j.status)}</td><td><span class="provider ${esc(j.provider)}">${esc(j.provider === "codex" ? "Codex" : "Claude")}</span></td><td>${esc(j.model)}</td><td class="muted">${esc(date(j.updated_at))}</td><td>↗</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="empty"><div class="empty-icon">⌘</div><h3>${$("#search").value || $("#status-filter").value || $("#provider-filter").value ? "No matching workloads" : workloadView === "active" ? "No active workloads" : "No projects in this view"}</h3><p>${workloadView === "active" ? "Create a workload, or browse Completed and All history to revisit earlier work." : "Browse retained projects here. Cancelled projects can be deleted by an administrator."}</p></td></tr>`;
  $$("[data-job]").forEach((r) => {
    r.onclick = () => (location.hash = "job/" + r.dataset.job);
    r.onkeydown = (e) => {
      if (e.key === "Enter") r.click();
    };
  });
  $("#total").textContent =
    `${d.total} workload${Number(d.total) === 1 ? "" : "s"} · 50 per page`;
  $("#page").textContent = String(page);
  $("#previous").disabled = page <= 1;
  $("#next").disabled = page * 50 >= Number(d.total);
}
function project(draft = null) {
  const f = $("#project-form");
  f.reset();
  $("#project-error").textContent = "";
  if (draft) {
    const idea = draft.result;
    f.elements.name.value = idea.name;
    f.prompt.value = idea.initial_prompt;
    f.provider.value = idea.recommended_worker;
  }
  $("#project-title").textContent = draft
    ? "Your next project, imagined by OpenAI"
    : "New project / workload";
  updateModels();
  if (draft) {
    const idea = draft.result;
    if (
      idea.recommended_worker === "codex" &&
      catalog.models.codex.includes("gpt-5.6-terra")
    )
      f.model.value = "gpt-5.6-terra";
    f.effort.value = idea.thinking;
    f.agents.checked = idea.enable_agents;
    f.dynamic_work.checked = idea.dynamic_work;
  }
  OpenAIUI.resetProject(draft);
  slugPreview();
  $("#project-dialog").showModal();
}
function updateModels() {
  const f = $("#project-form"),
    p = f.provider.value;
  f.model.innerHTML = catalog.models[p]
    .map((m) => `<option>${esc(m)}</option>`)
    .join("");
  f.effort.innerHTML = (
    p === "codex"
      ? catalog.model_efforts[f.model.value] || catalog.efforts[p]
      : catalog.efforts[p]
  )
    .map((m) => `<option ${m === "high" ? "selected" : ""}>${m}</option>`)
    .join("");
  $("#dynamic-label").classList.toggle("hidden", p !== "claude");
  if (p !== "claude") f.dynamic_work.checked = false;
}
function slugPreview() {
  const name = $("#project-form")
    .elements.name.value.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 130);
  $("#slug-preview").textContent =
    `Workspace: /srv/projects/${name || "your-project"}-[unique ID]`;
}
$("#project-form").provider.onchange = updateModels;
$("#project-form").model.onchange = () => {
  const f = $("#project-form"),
    p = f.provider.value;
  f.effort.innerHTML = (
    p === "codex"
      ? catalog.model_efforts[f.model.value] || catalog.efforts[p]
      : catalog.efforts[p]
  )
    .map((m) => `<option ${m === "high" ? "selected" : ""}>${esc(m)}</option>`)
    .join("");
};
$("#project-form").elements.name.oninput = slugPreview;
$("#project-form").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.currentTarget,
    b = $('[type="submit"]', f);
  b.disabled = true;
  const originalLabel = b.textContent;
  b.textContent =
    f.scaffold_source.value === "url"
      ? "Importing ZIP and creating…"
      : "Creating workload…";
  try {
    const result = await api("create", new FormData(f));
    f.lucky_id.value = "";
    $("#project-dialog").close();
    location.hash = "job/" + result.id;
    toast("Workload created and queued");
  } catch (err) {
    $("#project-error").textContent = err.message;
  } finally {
    b.disabled = false;
    b.textContent = originalLabel;
  }
};
async function detailView(id) {
  detailId = id;
  lastEvent = 0;
  $("#main").innerHTML =
    `<a class="back" href="#">← All workloads</a><div id="detail-head"></div><div id="questions"></div><div class="detail-grid"><section class="card"><h3>Initial prompt</h3><div id="prompt" class="prompt-text"></div></section><section class="card"><h3>Workload details</h3><div id="metadata" class="metadata"></div></section></div><section class="log-card"><div class="log-head"><span>● &nbsp; Worker output <span class="muted">/ live stream</span></span><label class="check"><input type="checkbox" id="autoscroll" checked> Follow output</label></div><pre id="logs" class="logs">Waiting for worker output…\n</pre></section><section class="card spacing-top"><h3>Send direction</h3><form id="message-form"><textarea name="body" required maxlength="16000" rows="3" placeholder="Add requirements, answer context, or steer the project…"></textarea><p class="hint">Queued messages are read by the worker’s inbox helper or delivered at the next turn. Use “Interrupt & steer” to stop the current turn and resume with your message.</p><div class="actions"><button class="primary">Queue message</button><button type="button" id="steer" class="secondary">Interrupt & steer</button></div></form><div id="messages"></div></section>`;
  $("#message-form").onsubmit = safe(async (e) => {
    e.preventDefault();
    await api("message", formData(e.currentTarget), "&id=" + id);
    e.target.reset();
    toast("Message queued");
    await refreshDetail();
  });
  $("#steer").onclick = safe(async () => {
    const f = $("#message-form");
    if (!f.reportValidity()) return;
    await api("message", formData(f), "&id=" + id);
    await api("control", { command: "steer" }, "&id=" + id);
    f.reset();
    toast("Steering requested");
    await refreshDetail();
  });
  await refreshDetail();
  await logs();
}
async function refreshDetail() {
  const id = detailId;
  if (!id) return;
  const d = await api("job", undefined, "&id=" + id);
  if (id !== detailId) return;
  const j = d.job;
  $("#detail-head").innerHTML =
    `<div class="page-head"><div><h1>${esc(j.name)}</h1><span class="job-path">/srv/projects/${esc(j.slug)}</span> &nbsp; ${badge(j.status)}</div><div class="actions">${["running", "preparing", "queued", "rate_limited"].includes(j.status) ? '<button class="secondary" data-control="pause">Pause</button>' : '<button class="secondary" data-control="resume">Resume / retry</button>'}<button class="danger" data-control="cancel">Cancel</button>${j.status === "cancelled" && me.role === "admin" ? '<button class="danger" id="delete-project">Delete project</button>' : ""}</div></div>${j.retry_at ? `<div class="notice">Provider cooldown · automatic retry after ${esc(date(j.retry_at))}</div>` : ""}${j.summary ? `<p class="muted">${esc(j.summary)}</p>` : ""}`;
  $$("[data-control]").forEach(
    (b) =>
      (b.onclick = safe(async () => {
        await api("control", { command: b.dataset.control }, "&id=" + id);
        await refreshDetail();
      })),
  );
  if (j.status === "deleting") $$("[data-control]").forEach((b) => b.remove());
  if ($("#delete-project"))
    $("#delete-project").onclick = safe(async () => {
      if (
        !confirm(
          `Permanently delete “${j.name}”? This removes /srv/projects/${j.slug}, logs, prompts, uploads and workload history. The audit record is kept.`,
        )
      )
        return;
      await api("job_delete", {}, "&id=" + id);
      detailId = null;
      workloadView = "closed";
      location.hash = "#";
      toast(
        "Deletion queued. Files and history will be removed within a minute.",
      );
    });
  $("#prompt").textContent = j.prompt;
  $("#metadata").innerHTML = [
    ["Worker", j.provider],
    ["Model", j.model],
    ["Run mode", j.mode],
    ["Thinking", j.effort],
    ["Agents", j.agents ? "Enabled" : "Disabled"],
    ["Dynamic work", j.dynamic_work ? "Enabled" : "Disabled"],
    ["Attempts", j.attempts],
    ["Created", date(j.created_at)],
    ["Session", j.session_id || "Not started"],
    ["Control", j.control || "—"],
  ]
    .map(([k, v]) => `<div><small>${esc(k)}</small>${esc(v)}</div>`)
    .join("");
  const pending = d.questions.filter((q) => !q.answer);
  const fingerprint = JSON.stringify(pending.map((q) => q.id));
  if ($("#questions").dataset.ids !== fingerprint) {
    $("#questions").dataset.ids = fingerprint;
    $("#questions").innerHTML = pending
      .map(
        (q) =>
          `<form class="question" data-question="${q.id}"><h3>Worker needs your input</h3><p>${esc(q.question)}</p><label>Your answer<textarea name="body" required maxlength="16000" rows="2"></textarea></label><button class="primary">Send answer & continue</button></form>`,
      )
      .join("");
    $$("[data-question]").forEach(
      (f) =>
        (f.onsubmit = safe(async (e) => {
          e.preventDefault();
          await api(
            "answer",
            { ...formData(f), question_id: Number(f.dataset.question) },
            "&id=" + id,
          );
          await refreshDetail();
        })),
    );
  }
  $("#messages").innerHTML = d.messages
    .map(
      (m) =>
        `<div class="message-item"><strong>${esc(m.username)}</strong> <span class="hint">${esc(date(m.created_at))} · ${m.delivered_at ? "Delivered" : "Queued"}</span><p>${esc(m.body)}</p></div>`,
    )
    .join("");
}
async function logs() {
  const id = detailId;
  if (!id) return;
  const d = await api("events", undefined, `&id=${id}&after=${lastEvent}`);
  if (id !== detailId) return;
  const el = $("#logs");
  if (d.events.length) {
    if (!lastEvent) el.textContent = "";
    for (const e of d.events) {
      el.append(
        document.createTextNode(`[${e.created_at}] ${e.kind}  ${e.body}\n`),
      );
      lastEvent = Number(e.id);
    }
    if (el.textContent.length > 1500000)
      el.textContent = el.textContent.slice(-1000000);
    if ($("#autoscroll").checked) el.scrollTop = el.scrollHeight;
  }
}
async function adminView() {
  const d = await api("admin"),
    s = Object.fromEntries(d.settings.map((x) => [x.key, JSON.parse(x.value)]));
  if (location.hash !== "#admin") return;
  $("#main").innerHTML =
    `<div class="page-head"><div><span class="eyebrow">WORKSHOP SETTINGS</span><h1>Administration</h1><span class="muted">Workers, people, and the little details.</span></div></div><div class="admin-grid">${OpenAIUI.adminCard()}<section class="card"><h3>Cancelled project cleanup</h3><form id="retention-form"><label class="check"><input name="enabled" type="checkbox" ${s.cancelled_cleanup_enabled ? "checked" : ""}>Automatically delete cancelled projects</label><label>Days after cancellation<input name="days" type="number" min="1" max="3650" value="${s.cancelled_retention_days ?? 30}" required></label><p class="hint">Permanently removes cancelled workspaces, uploads, prompts and logs. Audit records and existing backups remain. Completed and failed projects are excluded. Off by default; manual deletion is available on cancelled project pages.</p><button class="primary">Save cleanup policy</button></form></section><section class="card"><h3>Worker capacity & recovery</h3><form id="settings-form"><div class="form-grid"><label>Parallel Codex workers<input name="parallel_codex" type="number" min="1" max="16" value="${s.parallel_codex}" required></label><label>Parallel Claude workers<input name="parallel_claude" type="number" min="1" max="16" value="${s.parallel_claude}" required></label></div><p class="hint">Independent provider slots. One Claude and one Codex can always run together.</p><label>Base retry interval (seconds)<input name="retry_seconds" type="number" min="1" max="86400" value="${s.retry_seconds}" required></label><label>Codex models · one per line<textarea name="models_codex">${esc(s.models_codex.join("\n"))}</textarea></label><label>Claude models · one per line<textarea name="models_claude">${esc(s.models_claude.join("\n"))}</textarea></label><label class="check"><input type="checkbox" name="paused" ${s.paused ? "checked" : ""}>Pause new dispatches</label><button class="primary">Save settings</button></form><p class="hint">Cooldowns respect detected reset times. Unknown resets use bounded exponential retries. Account access determines which models work.</p><div class="actions"><button class="secondary" data-reset="codex">Retry Codex now</button><button class="secondary" data-reset="claude">Retry Claude now</button></div></section><section class="card"><h3>Discord webhooks</h3><p class="hint">Receive workload status notifications. Webhook URLs are stored privately and never returned to the browser. Enabling a webhook authorizes status delivery to that destination.</p><form id="webhook-form"><input type="hidden" name="id" value="0"><label>Name<input name="name" required maxlength="80"></label><label>Discord webhook URL<input name="url" type="url" placeholder="https://discord.com/api/webhooks/…" autocomplete="off"></label><label class="check"><input type="checkbox" name="enabled" checked>Enabled</label><button class="primary">Save webhook</button></form><div id="webhook-list">${d.webhooks.map((w) => `<div class="message-item">${esc(w.name)} · ${w.enabled ? "Enabled" : "Disabled"} <button class="subtle" data-hook-edit="${w.id}">Edit</button><button class="subtle" data-hook-delete="${w.id}">Delete</button></div>`).join("") || '<p class="muted">No webhooks configured.</p>'}</div><h3>Recent deliveries</h3>${d.deliveries.map((x) => `<p class="hint">Job #${x.job_id} · ${esc(x.status)} · ${x.delivered_at ? "Delivered" : `Pending (${x.attempts} attempts)`} ${esc(x.last_error || "")}</p>`).join("") || '<p class="hint">No deliveries yet.</p>'}</section><section class="card wide"><h3>User management</h3><div class="table-wrap"><table><thead><tr><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${d.users.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.role)}</td><td>${u.active ? "Active" : "Disabled"}</td><td><button class="subtle" data-user="${u.id}">Edit</button></td></tr>`).join("")}</tbody></table></div><form id="user-form"><input type="hidden" name="id" value="0"><div class="form-grid"><label>Username<input name="username" required minlength="3" maxlength="80"></label><label>Role<select name="role"><option value="operator">Operator</option><option value="admin">Administrator</option></select></label><label>Password<input name="password" type="password" minlength="14" autocomplete="new-password" placeholder="14+ characters; blank keeps existing"></label><label class="check"><input type="checkbox" name="active" checked>Account active</label></div><div class="actions"><button class="primary">Save user</button><button type="reset" class="secondary">New user</button></div></form></section><section class="card wide"><h3>Audit log · most recent 150 events</h3><div class="table-wrap"><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th><th>IP address</th></tr></thead><tbody>${d.audit.map((a) => `<tr><td>${esc(date(a.created_at))}</td><td>${esc(a.username || "system")}</td><td>${esc(a.action)}</td><td>${esc(a.target)}</td><td>${esc(a.ip)}</td></tr>`).join("")}</tbody></table></div></section></div>`;
  $("#retention-form").onsubmit = safe(async (e) => {
    e.preventDefault();
    const f = e.target;
    await api("retention", {
      enabled: f.enabled.checked,
      days: Number(f.days.value),
    });
    toast("Cleanup policy saved");
  });
  await OpenAIUI.mountAdmin();
  $("#settings-form").onsubmit = safe(async (e) => {
    e.preventDefault();
    const f = e.target,
      data = formData(f);
    data.paused = f.paused.checked;
    for (const p of ["codex", "claude"])
      data["models_" + p] = data["models_" + p].split(/\s+/).filter(Boolean);
    await api("settings", data);
    catalog = await api("catalog");
    toast("Settings saved");
  });
  $("#webhook-form").onsubmit = safe(async (e) => {
    e.preventDefault();
    await api("webhook_save", {
      ...formData(e.target),
      enabled: e.target.enabled.checked,
    });
    toast("Webhook saved");
    await adminView();
  });
  $$("[data-hook-edit]").forEach(
    (b) =>
      (b.onclick = () => {
        const w = d.webhooks.find((w) => w.id == b.dataset.hookEdit),
          f = $("#webhook-form");
        f.elements.id.value = w.id;
        f.elements.name.value = w.name;
        f.enabled.checked = !!w.enabled;
        f.url.value = "";
        f.elements.name.focus();
      }),
  );
  $$("[data-hook-delete]").forEach(
    (b) =>
      (b.onclick = safe(async () => {
        await api("webhook_delete", { id: b.dataset.hookDelete });
        await adminView();
      })),
  );
  $("#user-form").onsubmit = safe(async (e) => {
    e.preventDefault();
    await api("user_save", {
      ...formData(e.target),
      active: e.target.active.checked,
    });
    toast("User saved");
    await adminView();
  });
  $$("[data-user]").forEach(
    (b) =>
      (b.onclick = () => {
        const u = d.users.find((u) => u.id == b.dataset.user),
          f = $("#user-form");
        f.elements.id.value = u.id;
        f.username.value = u.username;
        f.role.value = u.role;
        f.active.checked = !!u.active;
        f.password.value = "";
        f.username.focus();
      }),
  );
  $$("[data-reset]").forEach(
    (b) =>
      (b.onclick = safe(async () => {
        await api("provider_reset", { provider: b.dataset.reset });
        toast("Provider cooldown cleared");
      })),
  );
}
$$("[data-close]").forEach(
  (b) => (b.onclick = () => b.closest("dialog").close()),
);
$("#logout").onclick = safe(async () => {
  await api("logout", {});
  await boot();
});
$("#account-button").onclick = () => $("#account-dialog").showModal();
$("#password-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("password", formData(e.target));
    e.target.reset();
    $("#account-dialog").close();
    toast("Password updated");
  } catch (err) {
    $(".form-error", e.target).textContent = err.message;
  }
};
window.addEventListener(
  "hashchange",
  safe(() => me && route()),
);
setInterval(() => {
  $("#clock").textContent =
    new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Copenhagen" }) +
    " CPH";
}, 1000);
setInterval(async () => {
  if (!me || refreshing) return;
  refreshing = true;
  try {
    if (detailId) {
      await refreshDetail();
      await logs();
    } else if ($("#jobs-body")) await loadJobs();
    await health();
  } catch (err) {
    $("#health").textContent = "Connection interrupted";
  } finally {
    refreshing = false;
  }
}, 2500);
OpenAIUI.configure({ api, esc, toast, project });
boot();
