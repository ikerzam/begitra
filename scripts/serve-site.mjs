#!/usr/bin/env node
// Serves the site the release script staged (src-tauri/target/release-site) on localhost with the
// headers deploy/releases/nginx.conf sends, to look at the pages before uploading them.
// Read-only, local only.
//
//   node scripts/serve-site.mjs [port]

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const site = fileURLToPath(new URL("../src-tauri/target/release-site/", import.meta.url));
const port = Number(process.argv[2] ?? 4173);

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".minisig": "text/plain; charset=utf-8",
};

// The same policy the server sends: the site's own styles, fonts and images, nothing else.
const headers = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  let path = normalize(join(site, decodeURIComponent(url.pathname)));
  if (!path.startsWith(site.replace(/[\\/]$/, "")) || path.includes(`${sep}..${sep}`)) {
    response.writeHead(403, headers).end();
    return;
  }
  try {
    if (statSync(path).isDirectory()) path = join(path, "index.html");
    statSync(path);
  } catch {
    response.writeHead(404, { ...headers, "Content-Type": "text/plain" }).end("404");
    return;
  }
  response.writeHead(200, {
    ...headers,
    "Content-Type": types[extname(path)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  createReadStream(path).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`serving ${site} at http://127.0.0.1:${port}/`);
});
