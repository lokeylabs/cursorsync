import { describe, it, expect } from "vitest";
import { buildDetailsHtml } from "./details-html.js";

const params = {
  cspSource: "vscode-resource://example",
  nonce: "deadbeefnonce",
  styleUri: "vscode-resource://example/media/details.css",
  scriptUri: "vscode-resource://example/media/details.js",
};

describe("buildDetailsHtml", () => {
  it("locks down the CSP and loads only nonce'd scripts", () => {
    const html = buildDetailsHtml(params);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`script-src 'nonce-${params.nonce}'`);
    expect(html).not.toContain("unsafe-inline");
    expect(html).toContain(`<script nonce="${params.nonce}" src="${params.scriptUri}">`);
    expect(html).toContain(params.styleUri);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});
