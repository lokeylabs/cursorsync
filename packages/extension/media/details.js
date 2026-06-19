// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("view");

  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  const fmtDate = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "—");

  function folderRow(path) {
    return `<div class="frow"><span class="fpath truncate" title="${esc(path)}">${esc(path)}</span>
      <button class="btn-sm" data-reveal="${esc(path)}">Reveal in Finder</button></div>`;
  }
  function hintChip(dir) {
    return `<button class="chip" data-reveal="${esc(dir)}" title="Reveal ${esc(dir)}">${esc(dir.split("/").slice(-2).join("/"))}</button>`;
  }
  function convRow(c) {
    const hints = (c.hints || []).map(hintChip).join("");
    return `<div class="crow">
      <div class="cmain"><span class="cname truncate" title="${esc(c.name)}">${esc(c.name)}</span>
        <span class="cmeta">${fmtDate(c.created)} · ${Number(c.msgs).toLocaleString()} msgs</span></div>
      ${hints ? `<div class="chints">${hints}</div>` : ""}
    </div>`;
  }

  function render(p) {
    const folders = p.folders.length
      ? `<div class="section"><h2>Local folders (${p.folders.length})</h2>${p.folders.map(folderRow).join("")}</div>`
      : `<div class="section"><p class="muted">These conversations aren't tied to a project folder. Use the location hints below to track them down.</p></div>`;
    const convs = `<div class="section"><h2>Conversations (${p.conversations.length}${p.truncated ? "+" : ""})</h2>
      ${p.conversations.map(convRow).join("") || '<p class="muted">No conversations.</p>'}
      ${p.truncated ? '<p class="muted">Showing the 400 most recent.</p>' : ""}</div>`;
    app.innerHTML = `<header><h1>${esc(p.label)}</h1><code class="repoid">${esc(p.repoId || "no repo")}</code></header>${folders}${convs}`;
  }

  app.addEventListener("click", (e) => {
    const el = e.target instanceof Element ? e.target.closest("[data-reveal]") : null;
    if (el) vscode.postMessage({ type: "reveal", path: el.getAttribute("data-reveal") });
  });
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "details") render(e.data.payload);
  });
  vscode.postMessage({ type: "ready" });
})();
