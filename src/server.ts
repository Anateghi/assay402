import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadConfig();
const app = createApp({ config });

// Static marketing site, docs and blog (generated into ./public by scripts/build-site.ts)
app.use("/*", async (c, next) => {
  await next();
  if (c.res.status === 200 && !c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "public, max-age=300");
  if (c.req.path.endsWith(".md") && c.res.status === 200) c.res.headers.set("content-type", "text/markdown; charset=utf-8");
});
app.use("/*", serveStatic({ root: "./public", rewriteRequestPath: (p) => (p.endsWith("/") ? p + "index.html" : /\.[a-z0-9]+$/i.test(p) ? p : p + "/index.html") }));
app.notFound(async (c) => {
  const fs = await import("node:fs/promises");
  const html = await fs.readFile("./public/404.html", "utf8").catch(() => "Not found");
  return c.html(html, 404);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(JSON.stringify({ level: "info", msg: "assay listening", port: info.port, network: config.network, payTo: config.payTo, facilitator: config.facilitatorUrl }));
});
