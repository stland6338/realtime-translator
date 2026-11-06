// npm run dev:mock を起動した状態で実行: node test/e2e.mjs
// 日本語話者 1 人 + 英語・韓国語・英語の聴講者 3 人で、途中結果と確定文の配信を検証する。
const BASE = process.env.BASE ?? "ws://localhost:8787";
const room = "e2e-" + Date.now();

function client(name, lang) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}/api/rooms/${room}/ws?lang=${lang}&name=${name}`);
    const c = { ws, name, lang, msgs: [] };
    ws.onmessage = (e) => { if (e.data !== "pong") c.msgs.push({ t: performance.now(), ...JSON.parse(e.data) }); };
    ws.onopen = () => resolve(c);
    ws.onerror = reject;
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok:", m); };

const sp = await client("taro", "ja");
const en1 = await client("alice", "en");
const ko = await client("minji", "ko");
const en2 = await client("bob", "en");
await sleep(200);

const t0 = performance.now();
sp.ws.send(JSON.stringify({ type: "text", segId: "1", text: "こんに", final: false }));
sp.ws.send(JSON.stringify({ type: "text", segId: "1", text: "こんにちは", final: false }));
sp.ws.send(JSON.stringify({ type: "text", segId: "1", text: "こんにちは皆さん", final: false }));
await sleep(50);
sp.ws.send(JSON.stringify({ type: "text", segId: "1", text: "こんにちは皆さん。", final: true }));
await sleep(500);

for (const c of [en1, ko, en2]) {
  const tr = c.msgs.filter((m) => m.type === "translation");
  const fin = tr.find((m) => m.final);
  assert(fin && fin.lang === c.lang && fin.text.includes("こんにちは皆さん。"), `${c.name}(${c.lang}) got final translation: ${fin?.text}`);
  assert(tr.every((m) => m.lang === c.lang), `${c.name} only receives its own language`);
  assert(tr.length <= 4, `${c.name} interim coalesced (${tr.length} translation msgs)`);
  console.log(`   latency to final for ${c.name}: ${((fin?.t ?? NaN) - t0).toFixed(1)}ms`);
}
const src = en1.msgs.filter((m) => m.type === "source");
assert(src.at(-1)?.final && src.at(-1).text === "こんにちは皆さん。", "source broadcast incl. final");
assert(!sp.msgs.some((m) => m.type === "translation"), "speaker (ja) gets no ja->ja translation");

// 確定後に遅れて届いた途中結果は無視される
sp.ws.send(JSON.stringify({ type: "text", segId: "1", text: "遅延", final: false }));
await sleep(200);
assert(!en1.msgs.some((m) => m.type === "source" && m.text === "遅延"), "late interim after final dropped");

// 途中参加者は履歴 (自分の言語の訳付き) を受け取る
const late = await client("late", "en");
await sleep(300);
const h = late.msgs.find((m) => m.type === "history");
assert(h?.items.length === 1 && h.items[0].translation?.includes("こんにちは"), "late joiner receives translated history");

// 言語切り替え後は新しい言語で届く
ko.ws.send(JSON.stringify({ type: "setLang", lang: "fr" }));
await sleep(100);
sp.ws.send(JSON.stringify({ type: "text", segId: "2", text: "次の話題です", final: true }));
await sleep(300);
assert(ko.msgs.some((m) => m.type === "translation" && m.lang === "fr" && m.segId.endsWith(":2")), "setLang switches target language");

// サーバー STT (バイナリ) 経路
const header = new TextEncoder().encode(JSON.stringify({ segId: "s1", lang: "ja", final: true }));
const wav = new Uint8Array(32000);
const frame = new Uint8Array(4 + header.length + wav.length);
new DataView(frame.buffer).setUint32(0, header.length, true);
frame.set(header, 4);
sp.ws.send(frame.buffer);
await sleep(300);
assert(en1.msgs.some((m) => m.type === "translation" && m.final && m.text.includes("audio 32000B")), "binary audio frame -> STT -> translation");

const pres = en1.msgs.filter((m) => m.type === "presence").at(-1);
assert(pres?.participants.length === 5, `presence lists 5 participants (${pres?.participants.length})`);

// ---- 管理 API
const HTTP = BASE.replace(/^ws/, "http");
const auth = { Authorization: "Bearer test-admin" };
assert((await fetch(`${HTTP}/api/admin/rooms`)).status === 401, "admin API rejects missing token");
assert((await fetch(`${HTTP}/api/admin/rooms`, { headers: { Authorization: "Bearer wrong" } })).status === 401, "admin API rejects wrong token");
await sleep(200);
const listed = await (await fetch(`${HTTP}/api/admin/rooms`, { headers: auth })).json();
const mine = listed.rooms.find((r) => r.name === room);
assert(mine?.connections === 5, `admin list shows room with 5 connections (${mine?.connections})`);

const closes = [sp, en1, ko, en2, late].map((c) => new Promise((r) => (c.ws.onclose = (e) => r(e.code))));
const res = await (await fetch(`${HTTP}/api/admin/rooms/${room}/close?purge=1`, { method: "POST", headers: auth })).json();
assert(res.closed === 5 && res.purged, `force close reports 5 closed (${JSON.stringify(res)})`);
await sleep(200);
assert([sp, en1, ko, en2, late].every((c) => c.msgs.some((m) => m.type === "closed")), "all clients notified of admin close");
// Node の WebSocket は TCP 切断まで close イベントを遅らせる (ローカル dev では約 10 秒) ため長めに待つ
const codes = await Promise.race([Promise.all(closes), sleep(15000).then(() => [])]);
assert(codes.length === 5 && codes.every((c) => c === 4001), `all clients closed with 4001 (${codes})`);
await sleep(200);
const after = await (await fetch(`${HTTP}/api/admin/rooms`, { headers: auth })).json();
assert(!after.rooms.some((r) => r.name === room), "closed room removed from list");
const again = await client("again", "en");
await sleep(300);
assert(again.msgs.find((m) => m.type === "history")?.items.length === 0, "purge cleared history");
again.ws.close();
await sleep(100);
