# 同時翻訳ルーム (Cloudflare Workers + Durable Objects + Workers AI)

話した言葉を、ルーム参加者それぞれの言語 (日本語・英語ほか 15 言語) でリアルタイムに字幕表示するアプリです。

## 仕組み

```
話者ブラウザ ──(WebSocket)──▶ Worker ──▶ Durable Object "Room" (ルーム名ごとに 1 つ)
  │ 音声認識                                    │ ・原文を即時ブロードキャスト
  │  A) Web Speech API (途中結果を逐次送信)       │ ・参加者の言語ごとに 1 回だけ翻訳 → 同言語の全員へファンアウト
  │  B) 16kHz PCM → WAV → Whisper              │ ・途中結果: m2m100 (高速)、推論中は最新だけ保留し古いものは破棄
  ▼                                            │ ・確定文: Llama 3.3 70B (直前の文脈つき)、失敗時は m2m100
聴講者ブラウザ ◀──── 原文 / 途中訳 / 確定訳 ─────┘ ・直近 50 件の履歴を保存 (途中参加者向け)
```

リアルタイム性のための工夫:

- **WebSocket Hibernation API**: 無音時は DO が休止し課金されず、ping/pong は `setWebSocketAutoResponse` で DO を起こさず応答。
- **途中結果の翻訳**: 話している最中から高速モデルで訳を出し、確定時に高品質訳で置き換える。
- **バックプレッシャー制御**: (セグメント×言語) ごとに推論は常に 1 本。追いつかない途中結果は最新だけ残して捨てる。
- **リビジョン番号**: 遅れて届いた古い途中訳が新しい訳を上書きしない。確定後の途中結果はサーバー側で破棄。
- **言語単位のファンアウト**: 聴講者が 100 人でも、言語が 3 種類なら翻訳は 3 回。言語ごとに完了次第送信。
- **サーバー STT モード**: クライアント側 VAD で発話を区切り、発話中も 1 秒ごとに途中認識。Web Speech 非対応ブラウザ (Firefox など) 向け。

## 使い方

```bash
npm install
npx wrangler login          # 初回のみ
npm run deploy              # https://realtime-translator.<subdomain>.workers.dev
```

ブラウザで開き、ルーム名・表示名・自分の言語を選んで参加 → 「招待リンクをコピー」で他の人を招待 → 「🎙 話す」。
各参加者は自分の言語で字幕を見ます。「読み上げ」をオンにすると確定訳を音声合成で読み上げます。

### ローカル開発

```bash
npm run dev        # Workers AI はリモート (Cloudflare アカウントが必要)
npm run dev:mock   # AI を呼ばずダミー翻訳で動作確認
npm test           # dev:mock 起動中に E2E テスト
```

### 設定 (`wrangler.jsonc` の `vars`)

| 変数 | 値 | 説明 |
|---|---|---|
| `FINAL_TRANSLATOR` | `llm` / `m2m100` | 確定文の翻訳モデル。`m2m100` にすると速く安いが品質は下がる |
| `MOCK_AI` | `0` / `1` | `1` で Workers AI を呼ばない |

## 使用モデル (Workers AI)

- 翻訳 (途中): `@cf/meta/m2m100-1.2b`
- 翻訳 (確定): `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- 音声認識 (サーバーモード): `@cf/openai/whisper-large-v3-turbo`
