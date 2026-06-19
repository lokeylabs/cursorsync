// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("view");
  /** @type {any} */ let state = null;

  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );

  const ICON = {
    gh: '<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.34c-2.23.49-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.71 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>',
    sync: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a7.5 7.5 0 0 1 12.8-5.3L19 8"/><path d="M19 3.5V8h-4.5"/><path d="M20 13a7.5 7.5 0 0 1-12.8 5.3L5 16"/><path d="M5 20.5V16h4.5"/></svg>',
    down: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>',
    folder:
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  };

  const REPO_HELP =
    "Pick which repos sync. Chats are tagged by their git repo, so you can sync any subset from any window. 'Auto-sync new repos' sets the default for repos you haven't chosen yet.";

  function signedOut() {
    return `
      <div class="card hero">
        <p class="hero-title">Your chats, on every device</p>
        <p class="hero-sub">Sign in to sync your Cursor history. It's private to you and protected by row-level security.</p>
        <button class="btn btn-gh" data-action="signIn">${ICON.gh} Sign in with GitHub</button>
      </div>`;
  }

  function repoRow(r) {
    const badge = r.isCurrent ? ' <span class="badge">this window</span>' : "";
    const folders = r.folderCount > 1 ? ` · ${r.folderCount} folders` : "";
    const details = `<button class="icon-btn" data-action="openDetails" data-repo="${esc(r.repo)}" title="View folders & chats" aria-label="Details for ${esc(r.label)}">${ICON.folder}</button>`;
    return `
      <div class="repo-row">
        <div class="repo-info">
          <div class="repo-name truncate" title="${esc(r.repo || "No repo")}">${esc(r.label)}${badge}</div>
          <div class="repo-count">${Number(r.count).toLocaleString()} chat${r.count === 1 ? "" : "s"}${folders}</div>
        </div>
        ${details}
        <div class="toggle sm ${r.enabled ? "on" : ""}" data-action="toggleRepo" data-repo="${esc(r.repo)}" role="switch" aria-checked="${r.enabled}"><div class="knob"></div></div>
      </div>`;
  }

  function reposCard(s) {
    const rows = (s.repos || []).map(repoRow).join("");
    const empty =
      '<div class="repo-empty muted">No repos found yet — run a sync to populate this list.</div>';
    return `
      <div class="card">
        <div class="row-label">Synced repos <span class="help" title="${esc(REPO_HELP)}">?</span></div>
        <div class="stat-row between auto-new">
          <span>Auto-sync new repos</span>
          <div class="toggle ${s.autoSyncNew ? "on" : ""}" data-action="toggleAutoNew" role="switch" aria-checked="${s.autoSyncNew}"><div class="knob"></div></div>
        </div>
        <div class="repo-list">${rows || empty}</div>
      </div>`;
  }

  function signedIn(s) {
    const syncing = s.status === "syncing";
    const lastSync = s.stats.lastSync ? esc(s.stats.lastSync) : "never";
    return `
      <div class="card user-card">
        ${s.user.avatarUrl ? `<img class="avatar" src="${esc(s.user.avatarUrl)}" alt="" />` : '<div class="avatar"></div>'}
        <div class="user-meta">
          <div class="user-name truncate">${esc(s.user.userName || "GitHub user")}</div>
          <div class="user-email truncate">${esc(s.user.email || "")}</div>
        </div>
        <button class="link" data-action="signOut">Sign out</button>
      </div>

      ${reposCard(s)}

      ${s.status === "error" ? `<div class="banner error">${esc(s.statusText)}</div>` : ""}

      <button class="btn btn-primary ${s.busy === "push" ? "loading" : ""}" data-action="syncNow" ${syncing ? "disabled" : ""}>
        ${ICON.sync} Sync now
      </button>
      <button class="btn btn-secondary ${s.busy === "pull" ? "loading" : ""}" data-action="pullNow" ${syncing ? "disabled" : ""}>
        ${ICON.down} Pull from cloud
      </button>

      <div class="card">
        <div class="stat-row"><span class="dot ${esc(s.status)}"></span><span class="truncate">${esc(s.statusText)}</span></div>
        <div class="stat-grid">
          <div><span class="num">${Number(s.stats.pushed).toLocaleString()}</span><span class="lbl">Pushed</span></div>
          <div><span class="num">${Number(s.stats.pulled).toLocaleString()}</span><span class="lbl">Pulled</span></div>
        </div>
        <div class="stat-row between"><span class="muted">Last sync</span><span class="truncate">${lastSync}</span></div>
        <div class="stat-row between">
          <span class="muted">Auto-sync</span>
          <div class="toggle ${s.autoSync ? "on" : ""}" data-action="toggleAuto" role="switch" aria-checked="${s.autoSync}"><div class="knob"></div></div>
        </div>
      </div>

      <div class="card">
        <div class="row-label">Activity</div>
        <div class="log">${(s.log || []).map((l) => esc(l)).join("<br>") || '<span class="muted">No activity yet</span>'}</div>
      </div>`;
  }

  function render(s) {
    state = s;
    app.innerHTML = s.user ? signedIn(s) : signedOut();
  }

  app.addEventListener("click", (e) => {
    const el = e.target instanceof Element ? e.target.closest("[data-action]") : null;
    if (!el || !state) return;
    const action = el.getAttribute("data-action");
    if (action === "toggleRepo") {
      const repo = el.getAttribute("data-repo");
      const entry = (state.repos || []).find((r) => r.repo === repo);
      vscode.postMessage({ type: "setRepoEnabled", repo, value: !(entry && entry.enabled) });
    } else if (action === "openDetails") {
      vscode.postMessage({ type: "openDetails", repo: el.getAttribute("data-repo") });
    } else if (action === "toggleAutoNew") {
      vscode.postMessage({ type: "setAutoSyncNew", value: !state.autoSyncNew });
    } else if (action === "toggleAuto") {
      vscode.postMessage({ type: "setAutoSync", value: !state.autoSync });
    } else {
      vscode.postMessage({ type: action });
    }
  });

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "state") render(e.data.state);
  });
  vscode.postMessage({ type: "ready" });
})();
