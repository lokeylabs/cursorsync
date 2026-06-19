/**
 * Pure HTML shell for the repo-details pop-out (opens as an editor tab). Like buildPanelHtml, the
 * data is rendered client-side (details.js) from a posted message; this just wires assets under a
 * strict CSP. Kept dependency-free so it is unit-testable.
 */
export interface DetailsHtmlParams {
  cspSource: string;
  nonce: string;
  styleUri: string;
  scriptUri: string;
}

export function buildDetailsHtml(p: DetailsHtmlParams): string {
  const csp = [
    `default-src 'none'`,
    `img-src ${p.cspSource} https: data:`,
    `style-src ${p.cspSource}`,
    `script-src 'nonce-${p.nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${p.styleUri}" />
</head>
<body>
  <div id="view"></div>
  <script nonce="${p.nonce}" src="${p.scriptUri}"></script>
</body>
</html>`;
}
