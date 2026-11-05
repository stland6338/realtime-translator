// ------------------------------------------------------------------ 定数
const LOCALES = {
  ja: "ja-JP", en: "en-US", zh: "zh-CN", ko: "ko-KR", es: "es-ES", fr: "fr-FR", de: "de-DE",
  pt: "pt-BR", it: "it-IT", ru: "ru-RU", vi: "vi-VN", th: "th-TH", id: "id-ID", ar: "ar-SA", hi: "hi-IN",
};
const LABELS = {
  ja: "日本語", en: "English", zh: "中文", ko: "한국어", es: "Español", fr: "Français", de: "Deutsch",
  pt: "Português", it: "Italiano", ru: "Русский", vi: "Tiếng Việt", th: "ไทย", id: "Bahasa Indonesia",
  ar: "العربية", hi: "हिन्दी",
};
const $ = (id) => document.getElementById(id);
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// ------------------------------------------------------------------ 状態
const params = new URLSearchParams(location.search);
const state = {
  room: params.get("room") || localStorage.getItem("room") || "",
  name: localStorage.getItem("name") || "",
  lang: localStorage.getItem("lang") || (navigator.language || "ja").slice(0, 2),
  myId: null,
  ws: null,
  retry: 0,
  speaking: false,
};
if (!LOCALES[state.lang]) state.lang = "en";
const segs = new Map(); // segId -> { el, srcRev, srcFinal, trRev, trFinal, srcLang }

// ------------------------------------------------------------------ 初期 UI
for (const sel of [$("lang"), $("langSwitch")]) {
  for (const [code, label] of Object.entries(LABELS)) sel.add(new Option(label, code));
  sel.value = state.lang;
}
$("room").value = state.room;
$("name").value = state.name;
if (!SR) {
  $("mode").value = "server";
  $("mode").options[0].disabled = true;
  $("mode").options[0].text += " - 非対応ブラウザ";
}

$("joinBtn").onclick = () => {
  state.room = ($("room").value.trim() || "lobby").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
  state.name = $("name").value.trim() || "guest";
  state.lang = $("lang").value;
  localStorage.setItem("room", state.room);
  localStorage.setItem("name", state.name);
  localStorage.setItem("lang", state.lang);
  history.replaceState(null, "", `?room=${encodeURIComponent(state.room)}`);
  $("join").hidden = true;
  $("app").hidden = false;
  $("roomTitle").textContent = `# ${state.room}`;
  $("langSwitch").value = state.lang;
  connect();
};
if (params.get("room") && state.name) $("joinBtn").click();

$("shareBtn").onclick = async () => {
  await navigator.clipboard.writeText(`${location.origin}/?room=${encodeURIComponent(state.room)}`);
  $("shareBtn").textContent = "コピーしました";
  setTimeout(() => ($("shareBtn").textContent = "招待リンクをコピー"), 1500);
};
$("langSwitch").onchange = () => {
  state.lang = $("langSwitch").value;
  localStorage.setItem("lang", state.lang);
  send({ type: "setLang", lang: state.lang });
  if (state.speaking) { stopMic(); startMic(); } // 認識言語も切り替え
};
$("micBtn").onclick = () => (state.speaking ? stopMic() : startMic());

// ------------------------------------------------------------------ WebSocket
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const qs = new URLSearchParams({ lang: state.lang, name: state.name });
  const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${encodeURIComponent(state.room)}/ws?${qs}`);
  ws.binaryType = "arraybuffer";
  state.ws = ws;
  ws.onopen = () => { state.retry = 0; $("status").classList.add("on"); };
  ws.onclose = () => {
    $("status").classList.remove("on");
    const delay = Math.min(10000, 500 * 2 ** state.retry++);
    setTimeout(connect, delay);
  };
  ws.onmessage = (ev) => {
    if (ev.data === "pong") return;
    onMessage(JSON.parse(ev.data));
  };
}
setInterval(() => state.ws?.readyState === 1 && state.ws.send("ping"), 25000);

function send(obj) {
  if (state.ws?.readyState === 1) state.ws.send(typeof obj === "string" || obj instanceof ArrayBuffer ? obj : JSON.stringify(obj));
}

function onMessage(m) {
  switch (m.type) {
    case "welcome":
      state.myId = m.id;
      break;
    case "presence":
      $("participants").innerHTML = m.participants
        .map((p) => `<span>👤 ${esc(p.name)} <small>(${LABELS[p.lang] || p.lang})</small></span>`)
        .join("");
      break;
    case "history":
      $("captions").innerHTML = "";
      segs.clear();
      for (const h of m.items) {
        onSource({ segId: h.segId, rev: 1e9, speaker: h.speaker, speakerId: "", srcLang: h.srcLang, text: h.text, final: true });
        if (h.translation && h.srcLang !== state.lang) onTranslation({ segId: h.segId, rev: 1e9, lang: m.lang, text: h.translation, final: true });
      }
      break;
    case "source":
      onSource(m);
      break;
    case "translation":
      onTranslation(m);
      break;
  }
}

// ------------------------------------------------------------------ 字幕描画
function getSeg(m) {
  let s = segs.get(m.segId);
  if (!s) {
    const el = document.createElement("div");
    el.className = "seg" + (m.speakerId && m.speakerId === state.myId ? " mine" : "");
    el.innerHTML = `<div class="who"></div><div class="tr"></div><div class="src"></div>`;
    el.querySelector(".who").textContent = `${m.speaker} · ${LABELS[m.srcLang] || m.srcLang}`;
    const box = $("captions");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.append(el);
    if (atBottom) box.scrollTop = box.scrollHeight;
    s = { el, srcRev: 0, srcFinal: false, trRev: 0, trFinal: false, srcLang: m.srcLang };
    segs.set(m.segId, s);
    while (segs.size > 200) {
      const [k, v] = segs.entries().next().value;
      v.el.remove();
      segs.delete(k);
    }
  }
  return s;
}

function onSource(m) {
  const s = getSeg(m);
  if (s.srcFinal || m.rev < s.srcRev) return;
  s.srcRev = m.rev;
  s.srcFinal = m.final;
  const same = m.srcLang === state.lang;
  const target = same ? s.el.querySelector(".tr") : s.el.querySelector(".src");
  target.textContent = m.text;
  target.classList.toggle("interim", !m.final);
  if (same) s.el.querySelector(".src").textContent = "";
  else if (!s.trRev) { // 訳が届くまでの間は原文を薄く表示
    const tr = s.el.querySelector(".tr");
    tr.textContent = "…";
    tr.classList.add("interim");
  }
  keepBottom();
}

function onTranslation(m) {
  if (m.lang !== state.lang) return;
  const s = segs.get(m.segId);
  if (!s || s.srcLang === state.lang) return;
  if (s.trFinal || m.rev < s.trRev) return; // 古い途中訳で上書きしない
  s.trRev = m.rev;
  s.trFinal = m.final;
  const tr = s.el.querySelector(".tr");
  tr.textContent = m.text;
  tr.classList.toggle("interim", !m.final);
  if (m.final && $("tts").checked && m.rev < 1e9) speak(m.text);
  keepBottom();
}

function keepBottom() {
  const box = $("captions");
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
}

function speak(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = LOCALES[state.lang];
  u.rate = 1.1;
  speechSynthesis.speak(u);
}

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ------------------------------------------------------------------ マイク
let stopFn = null;
async function startMic() {
  state.speaking = true;
  $("micBtn").textContent = "■ 停止";
  $("micBtn").classList.add("live");
  try {
    stopFn = $("mode").value === "browser" && SR ? startBrowserSTT() : await startServerSTT();
  } catch (e) {
    alert("マイクを開始できませんでした: " + e.message);
    stopMic();
  }
}
function stopMic() {
  state.speaking = false;
  stopFn?.();
  stopFn = null;
  $("micBtn").textContent = "🎙 話す";
  $("micBtn").classList.remove("live");
  $("meterBar").style.width = "0";
}

// --- モード 1: ブラウザ音声認識 (Web Speech API)。途中結果が数十 ms で出るので最速。
function startBrowserSTT() {
  let session = 0;
  let stopped = false;
  let rec;
  const throttle = new Map(); // segId -> { t, timer }

  const sendText = (segId, text, final) => {
    const msg = { type: "text", segId, text, final, lang: state.lang };
    const th = throttle.get(segId) || { t: 0, timer: null };
    clearTimeout(th.timer);
    const now = performance.now();
    if (final || now - th.t > 120) {
      th.t = now;
      send(msg);
    } else {
      th.timer = setTimeout(() => { th.t = performance.now(); send(msg); }, 120 - (now - th.t));
    }
    throttle.set(segId, th);
    if (final) throttle.delete(segId);
  };

  const begin = () => {
    session++;
    rec = new SR();
    rec.lang = LOCALES[state.lang];
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        sendText(`b${session}-${i}`, r[0].transcript, r.isFinal);
      }
      $("meterBar").style.width = "60%";
      setTimeout(() => ($("meterBar").style.width = "0"), 150);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed") { alert("マイクの使用が許可されていません"); stopMic(); }
    };
    rec.onend = () => { if (!stopped) begin(); }; // Chrome は一定時間で止まるので自動再開
    rec.start();
  };
  begin();
  return () => { stopped = true; rec?.stop(); };
}

// --- モード 2: サーバー認識。16kHz PCM を VAD で区切り、発話中は途中結果も送る。
async function startServerSTT() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule("/capture-worklet.js");
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "capture");
  src.connect(node);

  const ratio = ctx.sampleRate / 16000;
  const PRE_ROLL = 16000 * 0.3; // 発話開始前 300ms も含める
  const SILENCE_MS = 600; // この長さ無音が続いたら確定
  const MAX_MS = 9000; // 長すぎる発話は強制確定
  const INTERIM_MS = 1000; // 発話中の途中認識の間隔

  let ring = []; // 発話前のプリロール
  let ringLen = 0;
  let buf = []; // 現在の発話
  let bufLen = 0;
  let speaking = false;
  let lastVoice = 0;
  let startedAt = 0;
  let lastInterim = 0;
  let noise = 0.005;
  let seg = 0;
  let carry = new Float32Array(0);

  node.port.onmessage = ({ data }) => {
    // ダウンサンプリング (区間平均)。前回の端数サンプルを持ち越す。
    const input = new Float32Array(carry.length + data.length);
    input.set(carry);
    input.set(data, carry.length);
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const a = Math.floor(i * ratio), b = Math.floor((i + 1) * ratio);
      let s = 0;
      for (let j = a; j < b; j++) s += input[j];
      out[i] = s / (b - a);
    }
    carry = input.slice(Math.floor(outLen * ratio));

    let rms = 0;
    for (const v of data) rms += v * v;
    rms = Math.sqrt(rms / data.length);
    $("meterBar").style.width = `${Math.min(100, rms * 600)}%`;

    const now = performance.now();
    const voiced = rms > Math.max(0.012, noise * 3);
    if (!voiced) noise = noise * 0.995 + rms * 0.005;

    if (!speaking) {
      ring.push(out); ringLen += out.length;
      while (ringLen - ring[0].length > PRE_ROLL) ringLen -= ring.shift().length;
      if (voiced) {
        speaking = true; seg++;
        buf = ring; bufLen = ringLen; ring = []; ringLen = 0;
        startedAt = lastVoice = lastInterim = now;
      }
      return;
    }
    buf.push(out); bufLen += out.length;
    if (voiced) lastVoice = now;

    const ended = now - lastVoice > SILENCE_MS || now - startedAt > MAX_MS;
    if (ended) {
      sendAudio(seg, true);
      speaking = false; buf = []; bufLen = 0;
    } else if (now - lastInterim > INTERIM_MS && now - startedAt > 700) {
      lastInterim = now;
      sendAudio(seg, false);
    }
  };

  function sendAudio(segNo, final) {
    const pcm = new Float32Array(bufLen);
    let o = 0;
    for (const c of buf) { pcm.set(c, o); o += c.length; }
    if (final && pcm.length < 16000 * 0.4) return; // 短すぎる雑音は捨てる
    const wav = encodeWav(pcm);
    const header = new TextEncoder().encode(JSON.stringify({ segId: `s${segNo}`, lang: state.lang, final }));
    const frame = new Uint8Array(4 + header.length + wav.byteLength);
    new DataView(frame.buffer).setUint32(0, header.length, true);
    frame.set(header, 4);
    frame.set(new Uint8Array(wav), 4 + header.length);
    send(frame.buffer);
  }

  return () => {
    node.port.onmessage = null;
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
  };
}

function encodeWav(pcm) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
