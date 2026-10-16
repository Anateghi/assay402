import { safeFetch, FetchError } from "./safefetch.js";

export const ROBOTS_TOKEN = "assay-fetch";

interface Group { agents: string[]; rules: { allow: boolean; path: string }[] }

export function parseRobots(txt: string): Group[] {
  const groups: Group[] = [];
  let cur: Group | null = null; let lastWasAgent = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase(); const val = m[2]!.trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && cur) {
      lastWasAgent = false;
      if (val || key === "allow") cur.rules.push({ allow: key === "allow", path: val });
    } else lastWasAgent = false;
  }
  return groups;
}

function matches(pattern: string, path: string): boolean {
  if (pattern === "") return false;
  const re = "^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*").replace(/\\\$$/, "$");
  return new RegExp(re).test(path);
}

/** RFC 9309: pick our group (else "*"), longest match wins, allow wins ties. */
export function isAllowed(txt: string, pathWithQuery: string, token = ROBOTS_TOKEN): { allowed: boolean; rule: string | null } {
  const groups = parseRobots(txt);
  const ours = groups.filter((g) => g.agents.some((a) => a !== "*" && token.toLowerCase().startsWith(a)));
  const pick = ours.length ? ours : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; path: string } | null = null;
  for (const g of pick) for (const r of g.rules) {
    if (!matches(r.path, pathWithQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  if (!best) return { allowed: true, rule: null };
  return { allowed: best.allow, rule: `${best.allow ? "Allow" : "Disallow"}: ${best.path}` };
}

const cache = new Map<string, { txt: string; ts: number }>();

export async function checkRobots(u: URL): Promise<{ allowed: boolean; rule: string | null }> {
  const origin = u.origin;
  let entry = cache.get(origin);
  if (!entry || Date.now() - entry.ts > 3600_000) {
    let txt = "";
    try {
      const r = await safeFetch(new URL("/robots.txt", origin), { maxBytes: 512 * 1024, timeoutMs: 8000, accept: "text/plain" });
      if (r.status >= 200 && r.status < 300) txt = r.body.toString("utf8");
      else if (r.status >= 500) throw new FetchError("robots_unreachable", "robots.txt unreachable (5xx); treating as disallow per RFC 9309", 503);
    } catch (e) {
      if (e instanceof FetchError && e.code === "robots_unreachable") throw e;
      // 4xx / missing robots.txt => allowed
    }
    entry = { txt, ts: Date.now() };
    cache.set(origin, entry);
  }
  return isAllowed(entry.txt, u.pathname + u.search);
}
