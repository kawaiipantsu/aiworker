"use strict";
window.OpenAIUI = (() => {
  let app,
    adminTimer = null,
    generating = false,
    requestId = null,
    cancelled = false;
  const $ = (s) => document.querySelector(s),
    esc = (v) => app.esc(v),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const scaffold = () => {
    const source = $("#project-form").scaffold_source.value;
    $("#upload-source").classList.toggle("hidden", source !== "upload");
    $("#url-source").classList.toggle("hidden", source !== "url");
    $("#generated-source").classList.toggle("hidden", source !== "generated");
    $("#project-form").zip_url.required = source === "url";
    $("#project-form").zip_url.disabled = source !== "url";
    $("#project-form").zip.disabled = source !== "upload";
  };
  function configure(options) {
    app = options;
    $("#project-form").scaffold_source.onchange = scaffold;
    $("#project-dialog").addEventListener("close", () => {
      const id = $("#project-form").lucky_id.value;
      $("#project-form").lucky_id.value = "";
      if (id)
        void app
          .api("lucky_discard", {}, "&draft=" + encodeURIComponent(id))
          .catch((e) => app.toast(e.message));
    });
    $("#lucky-abort").onclick = abort;
    $("#lucky-loading").addEventListener("cancel", (e) => {
      e.preventDefault();
      void abort();
    });
  }
  async function abort() {
    cancelled = true;
    $("#lucky-loading").close();
    if (requestId) {
      const id = requestId;
      requestId = null;
      try {
        await app.api("lucky_discard", {}, "&draft=" + encodeURIComponent(id));
      } catch (e) {
        app.toast(e.message);
      }
    }
  }
  async function waitFor(id, onUpdate) {
    while (true) {
      if (cancelled && generating) throw new Error("Generation aborted.");
      const d = await app.api(
        "lucky_status",
        undefined,
        "&draft=" + encodeURIComponent(id),
      );
      onUpdate?.(d);
      if (d.status === "ready") return d;
      if (["failed", "cancelled", "used"].includes(d.status))
        throw new Error(d.error || "The OpenAI request was cancelled.");
      await sleep(1000);
    }
  }
  async function generate() {
    if (generating) return;
    generating = true;
    cancelled = false;
    requestId = null;
    const button = $("#lucky");
    if (button) {
      button.disabled = true;
      button.innerHTML =
        '<span class="spinner" aria-hidden="true"></span> OpenAI is working…';
      button.setAttribute("aria-busy", "true");
    }
    $("#lucky-progress").textContent = "Connecting to OpenAI…";
    $("#lucky-error").textContent = "";
    $("#lucky-loading-spinner").classList.remove("hidden");
    $("#lucky-loading").showModal();
    try {
      const created = await app.api("lucky_generate", {
        with_scaffold: $("#lucky-scaffold")?.checked ?? true,
      });
      requestId = created.id;
      if (cancelled) {
        await app.api("lucky_discard", {}, "&draft=" + created.id);
        return;
      }
      const draft = await waitFor(created.id, (d) => {
        $("#lucky-progress").textContent =
          d.status === "queued"
            ? "Your idea is queued. OpenAI will start shortly…"
            : "OpenAI is creating your project brief" +
              ($("#lucky-scaffold")?.checked
                ? " and optional starter files…"
                : "…");
      });
      if (cancelled) return;
      $("#lucky-loading").close();
      requestId = null;
      app.project(draft);
    } catch (error) {
      if (!cancelled) {
        $("#lucky-error").textContent = error.message;
        $("#lucky-progress").textContent = "The idea is not ready.";
        $("#lucky-loading-spinner").classList.add("hidden");
      }
    } finally {
      generating = false;
      const b = $("#lucky");
      if (b) {
        b.disabled = false;
        b.innerHTML = "✦ &nbsp; I feel lucky";
        b.removeAttribute("aria-busy");
      }
    }
  }
  function resetProject(draft) {
    const f = $("#project-form");
    f.lucky_id.value = draft?.id || "";
    $("#lucky-summary").classList.toggle("hidden", !draft);
    const option = $("#generated-option");
    option.hidden = !draft?.has_scaffold;
    option.disabled = !draft?.has_scaffold;
    if (draft) {
      const result = draft.result;
      $("#lucky-description").textContent = result.summary;
      $("#lucky-category").textContent =
        result.category +
        " · " +
        result.project_type.replaceAll("_", " ") +
        " · gpt-5.6-terra";
      $("#lucky-json-output").textContent = JSON.stringify(result, null, 2);
      $("#generated-files").innerHTML = result.scaffold_files
        .map((f) => "<li>" + esc(f.path) + "</li>")
        .join("");
      $("#scaffold-download").href =
        "/api.php?action=lucky_scaffold&draft=" + encodeURIComponent(draft.id);
      f.scaffold_source.value = draft.has_scaffold ? "generated" : "none";
    } else {
      f.scaffold_source.value = "upload";
      $("#generated-files").textContent = "";
      $("#lucky-json-output").textContent = "";
    }
    scaffold();
  }
  function adminCard() {
    return `<section class="card wide openai-card"><div class="page-head"><div><span class="eyebrow">I FEEL LUCKY</span><h3>OpenAI idea generator</h3><p class="hint">Project ideas are always generated with <strong>gpt-5.6-terra</strong>. Connect an OpenAI account or enter an API key.</p></div><span id="openai-status" class="badge">Loading connection…</span></div><div class="form-grid"><div><h3>Sign in with OpenAI</h3><p class="hint">Use your ChatGPT/Codex account. Open the official sign-in link, authorize the device code, and return here. Your account must have access to this model.</p><button id="openai-login" class="secondary">Sign in with OpenAI ↗</button><div id="openai-device" class="hidden"></div></div><form id="openai-key-form"><label>OpenAI API key<input name="api_key" type="password" required autocomplete="new-password" spellcheck="false" maxlength="512" placeholder="sk-…"></label><p class="hint">Stored encrypted on the server. The saved key is never sent back to the browser. An API key uses your OpenAI API billing.</p><button class="primary">Save API key</button></form></div><p id="openai-detail" class="hint"></p><p id="openai-error" class="form-error" role="status"></p><div class="actions"><button id="openai-test" class="secondary">Test connection</button><button id="openai-reset" class="danger">Reset connection</button></div><p class="hint">Reset removes this site's saved idea-generator credentials. Project worker logins remain separate. Test connection sends a small request to the fixed model.</p></section>`;
  }
  async function refreshAdmin() {
    if (!$("#openai-status")) {
      clearInterval(adminTimer);
      adminTimer = null;
      return;
    }
    const d = await app.api("openai_status");
    if (!$("#openai-status")) return;
    const c = d.connection,
      login = d.login,
      pending =
        login && ["queued", "starting", "waiting"].includes(login.status);
    $("#openai-status").textContent =
      c.mode === "none"
        ? "Not connected"
        : c.mode === "chatgpt"
          ? "OpenAI account connected"
          : "API key saved";
    $("#openai-status").className =
      "badge " + (c.mode === "none" ? "paused" : "completed");
    $("#openai-detail").textContent =
      (c.label ? c.label + " · " : "") +
      (c.verified_at
        ? "Last successful model request: " +
          new Date(c.verified_at.replace(" ", "T") + "Z").toLocaleString()
        : "The connection has not been tested yet.") +
      (d.service ? "" : " · Idea service offline");
    $("#openai-login").disabled = !!pending;
    $("#openai-reset").disabled = c.mode === "none" && !pending;
    if (!$("#openai-test").dataset.running)
      $("#openai-test").disabled = c.mode === "none";
    $("#openai-device").classList.toggle("hidden", !pending);
    if (pending) {
      $("#openai-device").innerHTML =
        login.status === "waiting"
          ? `<div class="device-code"><p>1. <a href="${esc(login.verification_url)}" target="_blank" rel="noopener noreferrer">Open OpenAI sign-in ↗</a></p><p>2. Enter this one-time code:</p><strong>${esc(login.user_code)}</strong><p class="hint">Waiting for authorization. This page updates automatically.</p></div><button id="openai-cancel-login" class="subtle">Cancel sign-in</button>`
          : `<p class="hint"><span class="spinner"></span> Preparing your secure sign-in…</p><button id="openai-cancel-login" class="subtle">Cancel sign-in</button>`;
      $("#openai-cancel-login").onclick = () =>
        act(async () => {
          await app.api("openai_login_cancel", { id: login.id });
          await refreshAdmin();
        });
    }
    if (!$("#openai-test").dataset.running)
      $("#openai-error").textContent =
        (login?.status === "failed" &&
        (!c.updated_at || login.created_at >= c.updated_at)
          ? login.error
          : "") ||
        c.last_error ||
        "";
  }
  async function act(fn) {
    try {
      await fn();
    } catch (e) {
      if ($("#openai-error")) $("#openai-error").textContent = e.message;
      else app.toast(e.message);
    }
  }
  async function mountAdmin() {
    clearInterval(adminTimer);
    $("#openai-login").onclick = () =>
      act(async () => {
        await app.api("openai_login", {});
        await refreshAdmin();
      });
    $("#openai-key-form").onsubmit = (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      void act(async () => {
        const button = form.querySelector("button");
        button.disabled = true;
        try {
          await app.api("openai_save", { api_key: form.api_key.value });
          form.reset();
          app.toast("OpenAI API key saved");
          await refreshAdmin();
        } finally {
          button.disabled = false;
        }
      });
    };
    $("#openai-reset").onclick = () =>
      act(async () => {
        await app.api("openai_reset", {});
        app.toast("Idea-generator credentials removed");
        await refreshAdmin();
      });
    $("#openai-test").onclick = () =>
      act(async () => {
        const b = $("#openai-test");
        b.disabled = true;
        b.dataset.running = "true";
        b.innerHTML = '<span class="spinner"></span> Testing gpt-5.6-terra…';
        $("#openai-error").textContent = "";
        try {
          const r = await app.api("openai_test", {});
          await waitFor(r.id);
          app.toast("OpenAI connection verified");
        } finally {
          if (b.isConnected) {
            delete b.dataset.running;
            b.innerHTML = "Test connection";
            await refreshAdmin();
          }
        }
      });
    await act(refreshAdmin);
    adminTimer = setInterval(() => {
      void act(refreshAdmin);
    }, 2000);
  }
  return { configure, generate, resetProject, scaffold, adminCard, mountAdmin };
})();
