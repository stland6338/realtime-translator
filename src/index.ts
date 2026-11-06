import { LANGUAGES } from "./languages";
import type { Env } from "./translate";

export { Room } from "./room";
export { Registry } from "./registry";

const ROOM_RE = /^\/api\/rooms\/([A-Za-z0-9_-]{1,64})\/ws$/;
const ADMIN_CLOSE_RE = /^\/api\/admin\/rooms\/([A-Za-z0-9_-]{1,64})\/close$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/languages") {
      return Response.json(LANGUAGES);
    }

    const m = url.pathname.match(ROOM_RE);
    if (m) {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      // ルーム名ごとに 1 つの Durable Object。接続者に近いリージョンで最初に生成される。
      const name = m[1].toLowerCase();
      const fwd = new Request(req);
      fwd.headers.set("X-Room-Name", name);
      return env.ROOM.get(env.ROOM.idFromName(name)).fetch(fwd);
    }

    if (url.pathname.startsWith("/api/admin/")) return admin(req, url, env);

    // それ以外は静的アセット (public/) が処理する
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** 管理 API。`Authorization: Bearer <ADMIN_TOKEN>` が必要。 */
async function admin(req: Request, url: URL, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN) return Response.json({ error: "ADMIN_TOKEN is not configured" }, { status: 503 });
  if (!(await safeEqual(req.headers.get("Authorization") ?? "", `Bearer ${env.ADMIN_TOKEN}`))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const registry = env.REGISTRY.get(env.REGISTRY.idFromName("global"));

  if (url.pathname === "/api/admin/rooms" && req.method === "GET") {
    return Response.json({ rooms: await registry.list() });
  }

  const c = url.pathname.match(ADMIN_CLOSE_RE);
  if (c && req.method === "POST") {
    const name = c[1].toLowerCase();
    const purge = url.searchParams.get("purge") === "1";
    const r = await env.ROOM.get(env.ROOM.idFromName(name)).adminClose(purge);
    return Response.json({ room: name, purged: purge, ...r });
  }

  if (url.pathname === "/api/admin/close-all" && req.method === "POST") {
    const purge = url.searchParams.get("purge") === "1";
    const rooms = await registry.list();
    const results = await Promise.all(
      rooms.map(async (r) => ({ room: r.name, ...(await env.ROOM.get(env.ROOM.idFromName(r.name)).adminClose(purge)) })),
    );
    return Response.json({ purged: purge, results });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
