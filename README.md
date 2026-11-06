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

### 自動デプロイ (GitHub Actions)

`main` へのプッシュでテスト → Cloudflare へ自動デプロイします (`.github/workflows/deploy.yml`)。
リポジトリの Settings → Secrets and variables → Actions に次の 2 つを登録してください。

- `CLOUDFLARE_API_TOKEN`: テンプレート「Edit Cloudflare Workers」で作成した API トークン
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare ダッシュボードの Workers & Pages 画面右側に表示されるアカウント ID

### Durable Object の動き方と強制終了

- ルーム名ごとに Durable Object が 1 つだけ作られます。同じルームに何人・何タブ入っても 1 インスタンスです。
- 誰も話していない間はハイバネーション (メモリから退避) し、時間課金は発生しません。全員が退出すると数秒後に停止します。
- 履歴 (直近 50 件) はルームごとの DO ストレージに残ります。

管理画面 `/admin.html` (または API) で稼働中のルーム一覧の確認と、強制終了ができます。`ADMIN_TOKEN` を GitHub Secrets に登録すると、デプロイ時に Worker のシークレットへ反映されます (未設定時は管理 API は 503)。

```bash
TOKEN=...; BASE=https://realtime-translator.<subdomain>.workers.dev
curl -H "Authorization: Bearer $TOKEN" $BASE/api/admin/rooms                                 # 一覧
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/rooms/<room>/close"          # 切断
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/rooms/<room>/close?purge=1"  # 切断+履歴削除
curl -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/close-all"                   # 全ルーム切断
```

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
