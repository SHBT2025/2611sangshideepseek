// Minimal static file server for local testing.
const http = require("http");
const fs = require("fs");
const path = require("path");
const root = __dirname;
const port = Number(process.env.PORT || 8099);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".css": "text/css", ".json": "application/json" };
const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || "/").split("?")[0]);
  if (url === "/") url = "/index.html";
  const p = path.join(root, path.normalize(url).replace(/^([/\\])+/, ""));
  if (!p.startsWith(root)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
});
server.listen(port, "127.0.0.1", () => console.log("serving on http://127.0.0.1:" + port));
