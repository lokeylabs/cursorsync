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
  };

  const SCOPE_HINT = {
    all: "Syncing <b>every conversation across all your repos</b>.",
    repo: "Syncing <b>only chats for the repo you have open</b>.",
  };
  const SCOPE_HELP =
    "Auto-sync runs in the background either way. Scope just sets what it covers: All chats = your whole history; This repo = only the current project (matched by git remote).";

  function signedOut() {
    return `
      <div class="card hero">
        <p class="hero-title">Your chats, on every device</p>
        <p class="hero-sub">Sign in to sync your Cursor history. It's private to you and protected by row-level security.</p>
        <button class="btn btn-gh" data-action="signIn">${ICON.gh} Sign in with GitHub</button>
      </div>`;
  }

  function signedIn(s) {
    const syncing = s.status === "syncing";
    const repo = s.repo ? esc(s.repo) : "no repo detected";
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

      <div class="card">
        <div class="row-label">Sync scope <span class="help" title="${esc(SCOPE_HELP)}">?</span></div>
        <div class="seg">
          <button class="seg-btn ${s.scope === "all" ? "active" : ""}" data-action="setScope" data-value="all">All chats</button>
          <button class="seg-btn ${s.scope === "repo" ? "active" : ""}" data-action="setScope" data-value="repo">This repo</button>
        </div>
        <p class="scope-hint">${SCOPE_HINT[s.scope] ?? ""}</p>
        <div class="repo-line">
          <span class="repo-key">Repo</span>
          <span class="repo-val ${s.repo ? "" : "muted"} truncate" title="${repo}">${repo}</span>
        </div>
      </div>

      ${s.status === "error" ? `<div class="banner error">${esc(s.statusText)}</div>` : ""}

      <button class="btn btn-primary ${syncing ? "loading" : ""}" data-action="syncNow" ${syncing ? "disabled" : ""}>
        ${ICON.sync} Sync now
      </button>
      <button class="btn btn-secondary ${syncing ? "loading" : ""}" data-action="pullNow" ${syncing ? "disabled" : ""}>
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
    if (action === "setScope")
      vscode.postMessage({ type: "setScope", value: el.getAttribute("data-value") });
    else if (action === "toggleAuto")
      vscode.postMessage({ type: "setAutoSync", value: !state.autoSync });
    else vscode.postMessage({ type: action });
  });

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "state") render(e.data.state);
  });
  vscode.postMessage({ type: "ready" });
})();
