import { LANGUAGES } from "./languages";
import type { Env } from "./translate";

export { Room } from "./room";

const ROOM_RE = /^\/api\/rooms\/([A-Za-z0-9_-]{1,64})\/ws$/;

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
      const stub = env.ROOM.get(env.ROOM.idFromName(m[1].toLowerCase()));
      return stub.fetch(req);
    }

    // それ以外は静的アセット (public/) が処理する
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
