import { DurableObject } from "cloudflare:workers";
import { isLang } from "./languages";
import { Env, transcribe, translateFast, translateLLM } from "./translate";

/** WebSocket ごとに保存する情報 (ハイバネーションを跨いで保持される)。 */
interface Attachment {
  id: string;
  name: string;
  lang: string;
}

interface HistoryItem {
  segId: string;
  speaker: string;
  srcLang: string;
  text: string;
  ts: number;
  translations: Record<string, string>;
}

/** 1 つの (セグメント, 言語) に対する翻訳ジョブの状態。途中結果は最新のものだけ翻訳する。 */
interface LaneState {
  inflight: boolean;
  pending: { text: string; rev: number } | null;
}

const HISTORY_LIMIT = 50;
const CONTEXT_LIMIT = 4;

export class Room extends DurableObject<Env> {
  // 以下はメモリ上の一時状態。ハイバネーションで消えても問題ないものだけを置く。
  private revs = new Map<string, number>(); // segId -> 最新リビジョン
  private finalized = new Set<string>(); // 確定済み segId
  private lanes = new Map<string, LaneState>(); // `${segId}|${lang}` -> 状態
  private sttLanes = new Map<string, { inflight: boolean; pending: ArrayBuffer | null }>();
  private cache = new Map<string, string>(); // `${from}|${to}|${text}` -> 訳文 (小さな LRU)
  private context: string[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // ping/pong は DO を起こさずに自動応答 (ハイバネーション中も接続維持)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(req.url);
    const roomName = req.headers.get("X-Room-Name");
    if (roomName && (await this.ctx.storage.get("name")) !== roomName) await this.ctx.storage.put("name", roomName);
    const lang = url.searchParams.get("lang") ?? "en";
    const att: Attachment = {
      id: crypto.randomUUID().slice(0, 8),
      name: (url.searchParams.get("name") ?? "guest").slice(0, 32) || "guest",
      lang: isLang(lang) ? lang : "en",
    };
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(att);

    server.send(JSON.stringify({ type: "welcome", id: att.id }));
    this.ctx.waitUntil(this.sendHistory(server, att.lang));
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------------------------------------------------------------- WebSocket handlers

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment;
    if (typeof msg !== "string") return this.onAudio(att, msg);

    let m: any;
    try {
      m = JSON.parse(msg);
    } catch {
      return;
    }
    switch (m.type) {
      case "setLang":
        if (isLang(m.lang) && m.lang !== att.lang) {
          att.lang = m.lang;
          ws.serializeAttachment(att);
          this.broadcastPresence();
          await this.sendHistory(ws, att.lang);
        }
        break;
      case "setName":
        if (typeof m.name === "string" && m.name.trim()) {
          att.name = m.name.trim().slice(0, 32);
          ws.serializeAttachment(att);
          this.broadcastPresence();
        }
        break;
      case "text": // ブラウザ側音声認識 (Web Speech API) の結果
        if (typeof m.segId === "string" && typeof m.text === "string") {
          const lang = isLang(m.lang) ? m.lang : att.lang;
          await this.onUtterance(att, `${att.id}:${m.segId}`, lang, m.text, !!m.final);
        }
        break;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {}
    this.broadcastPresence(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcastPresence(ws);
  }

  // ---------------------------------------------------------------- 音声 (サーバー STT モード)

  /**
   * バイナリフレーム: [uint32 ヘッダ長][JSON ヘッダ][16kHz mono WAV]
   * ヘッダ: { segId, lang, final }
   * 発話中は伸びていくバッファを途中結果として、無音検出時に確定として送られてくる。
   */
  private async onAudio(att: Attachment, buf: ArrayBuffer): Promise<void> {
    if (buf.byteLength < 4) return;
    const hlen = new DataView(buf).getUint32(0, true);
    let h: { segId: string; lang: string; final: boolean };
    try {
      h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen)));
    } catch {
      return;
    }
    const wav = buf.slice(4 + hlen);
    const segId = `${att.id}:${h.segId}`;
    const lang = isLang(h.lang) ? h.lang : att.lang;

    if (h.final) {
      this.sttLanes.delete(segId);
      const text = await transcribe(this.env, wav, lang).catch((e) => (console.error(e), ""));
      if (text) await this.onUtterance(att, segId, lang, text, true);
      return;
    }
    // 途中結果: 推論中なら最新の音声だけを保留し、古いものは捨てる
    if (this.finalized.has(segId)) return;
    let lane = this.sttLanes.get(segId);
    if (!lane) this.sttLanes.set(segId, (lane = { inflight: false, pending: null }));
    if (lane.inflight) {
      lane.pending = wav;
      return;
    }
    lane.inflight = true;
    let cur: ArrayBuffer | null = wav;
    while (cur) {
      const text = await transcribe(this.env, cur, lang).catch(() => "");
      if (this.finalized.has(segId) || !this.sttLanes.has(segId)) break;
      if (text) await this.onUtterance(att, segId, lang, text, false);
      cur = lane.pending;
      lane.pending = null;
    }
    lane.inflight = false;
  }

  // ---------------------------------------------------------------- 翻訳パイプライン

  private async onUtterance(att: Attachment, segId: string, srcLang: string, text: string, final: boolean) {
    text = text.trim();
    if (!text || this.finalized.has(segId)) return;
    const rev = (this.revs.get(segId) ?? 0) + 1;
    this.revs.set(segId, rev);
    if (final) this.finalized.add(segId);

    // 原文は即座に全員へ (同じ言語の人はこれがそのまま字幕になる)
    this.broadcast({ type: "source", segId, rev, speaker: att.name, speakerId: att.id, srcLang, text, final });

    const targets = this.targetLangs(srcLang);
    if (final) {
      const ctx = this.context.slice();
      this.context.push(text);
      if (this.context.length > CONTEXT_LIMIT) this.context.shift();
      const item: HistoryItem = { segId, speaker: att.name, srcLang, text, ts: Date.now(), translations: {} };
      // 言語ごとに並列で翻訳し、終わったものから順に送る (全言語の完了を待たない)
      await Promise.all(
        targets.map(async (to) => {
          const out = await this.translate(text, srcLang, to, true, ctx);
          if (!out) return;
          item.translations[to] = out;
          this.sendToLang(to, { type: "translation", segId, rev, lang: to, text: out, final: true });
        }),
      );
      await this.appendHistory(item);
      this.cleanupSeg(segId);
    } else {
      await Promise.all(targets.map((to) => this.runInterimLane(segId, srcLang, to, text, rev)));
    }
  }

  /** 途中結果の翻訳。同じレーンで推論中なら最新テキストだけ保留して、古い途中結果は捨てる。 */
  private async runInterimLane(segId: string, from: string, to: string, text: string, rev: number) {
    const key = `${segId}|${to}`;
    let lane = this.lanes.get(key);
    if (!lane) this.lanes.set(key, (lane = { inflight: false, pending: null }));
    if (lane.inflight) {
      lane.pending = { text, rev };
      return;
    }
    lane.inflight = true;
    let job: { text: string; rev: number } | null = { text, rev };
    while (job && !this.finalized.has(segId)) {
      const out = await this.translate(job.text, from, to, false, []);
      if (this.finalized.has(segId)) break;
      if (out) this.sendToLang(to, { type: "translation", segId, rev: job.rev, lang: to, text: out, final: false });
      job = lane.pending;
      lane.pending = null;
    }
    lane.inflight = false;
  }

  private async translate(text: string, from: string, to: string, final: boolean, ctx: string[]): Promise<string> {
    const useLLM = final && this.env.FINAL_TRANSLATOR === "llm";
    const key = `${useLLM ? "L" : "F"}|${from}|${to}|${text}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let out = "";
    try {
      out = useLLM ? await translateLLM(this.env, text, from, to, ctx) : await translateFast(this.env, text, from, to);
    } catch (e) {
      console.error("translate failed", from, to, e);
    }
    if (out) {
      this.cache.set(key, out);
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    }
    return out;
  }

  private cleanupSeg(segId: string) {
    for (const k of this.lanes.keys()) if (k.startsWith(segId + "|")) this.lanes.delete(k);
    this.revs.delete(segId);
    // finalized は遅れて届く途中結果を弾くためにしばらく残す
    if (this.finalized.size > 1000) this.finalized.clear();
  }

  // ---------------------------------------------------------------- 履歴 (途中参加者向け)

  private async appendHistory(item: HistoryItem) {
    const hist = (await this.ctx.storage.get<HistoryItem[]>("history")) ?? [];
    hist.push(item);
    while (hist.length > HISTORY_LIMIT) hist.shift();
    await this.ctx.storage.put("history", hist);
  }

  private async sendHistory(ws: WebSocket, lang: string) {
    const hist = (await this.ctx.storage.get<HistoryItem[]>("history")) ?? [];
    const items = hist.map((h) => ({
      segId: h.segId,
      speaker: h.speaker,
      srcLang: h.srcLang,
      text: h.text,
      ts: h.ts,
      translation: h.srcLang === lang ? h.text : (h.translations[lang] ?? null),
    }));
    safeSend(ws, { type: "history", lang, items });

    // まだその言語の訳がない履歴は高速モデルで補完する
    const missing = hist.filter((h) => h.srcLang !== lang && !h.translations[lang]).slice(-15);
    if (!missing.length) return;
    await Promise.all(
      missing.map(async (h) => {
        const out = await this.translate(h.text, h.srcLang, lang, false, []);
        if (out) {
          h.translations[lang] = out;
          safeSend(ws, { type: "translation", segId: h.segId, rev: 1e9, lang, text: out, final: true });
        }
      }),
    );
    await this.ctx.storage.put("history", hist);
  }

  // ---------------------------------------------------------------- 管理 (RPC)

  /** 全接続を強制的に切断する。purge=true なら履歴などの保存データも削除する。 */
  async adminClose(purge: boolean): Promise<{ closed: number }> {
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      try {
        safeSend(ws, { type: "closed", reason: "admin" });
        ws.close(4001, "closed by admin");
      } catch {}
    }
    const name = await this.ctx.storage.get<string>("name");
    if (purge) {
      await this.ctx.storage.deleteAll();
      this.cache.clear();
      this.context = [];
    }
    if (name) await this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global")).report({
      name, connections: 0, participants: [], updatedAt: Date.now(),
    });
    return { closed: sockets.length };
  }

  // ---------------------------------------------------------------- 配信

  private sockets(): { ws: WebSocket; att: Attachment }[] {
    return this.ctx.getWebSockets().map((ws) => ({ ws, att: ws.deserializeAttachment() as Attachment }));
  }

  private targetLangs(srcLang: string): string[] {
    const set = new Set<string>();
    for (const { att } of this.sockets()) if (att.lang !== srcLang) set.add(att.lang);
    return [...set];
  }

  private broadcast(obj: unknown) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) safeSend(ws, s);
  }

  /** 翻訳は言語ごとに 1 回だけ実行し、その言語の参加者全員にファンアウトする。 */
  private sendToLang(lang: string, obj: unknown) {
    const s = JSON.stringify(obj);
    for (const { ws, att } of this.sockets()) if (att.lang === lang) safeSend(ws, s);
  }

  private broadcastPresence(exclude?: WebSocket) {
    const participants = this.sockets()
      .filter(({ ws }) => ws !== exclude && ws.readyState === WebSocket.OPEN)
      .map(({ att }) => ({ id: att.id, name: att.name, lang: att.lang }));
    this.broadcast({ type: "presence", participants });
    this.ctx.waitUntil(this.reportToRegistry(participants));
  }

  /** 稼働中ルーム一覧 (Registry) に接続状況を報告する。 */
  private async reportToRegistry(participants: { name: string; lang: string }[]) {
    try {
      const name = await this.ctx.storage.get<string>("name");
      if (!name) return;
      await this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global")).report({
        name,
        connections: participants.length,
        participants: participants.map(({ name, lang }) => ({ name, lang })),
        updatedAt: Date.now(),
      });
    } catch (e) {
      console.error("registry report failed", e);
    }
  }
}

function safeSend(ws: WebSocket, data: unknown) {
  try {
    ws.send(typeof data === "string" ? data : JSON.stringify(data));
  } catch {}
}
