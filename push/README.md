# dojo-push（リーディング道場のプッシュ通知サーバー）

Cloudflare Workers ＋ Durable Objects（無料プラン）で動く、Web Push の送信サーバーです。

- 端末ごとに「通知する時刻・タイムゾーン・今日の進み具合」を預かり、その時刻に今日の分が終わっていなければ通知を送ります。
- 時刻どおりに送るため、cron ではなく Durable Object の alarm を「次に送る時刻」に合わせています。
- 通知は Declarative Web Push の形（`{"web_push": 8030, "notification": {...}, "app_badge": 残り本数}`）で送ります。iOS 18.4 以降はサービスワーカーを通さずに表示し、アイコンのバッジも同時に更新します。ほかのブラウザでは `sw.js` の `push` イベントで表示します。
- 暗号化（RFC 8291 aes128gcm）と VAPID（RFC 8292）は `src/webpush.js` に WebCrypto だけで実装しています。RFC 8291 の例の値で、出力が一致することを確認済みです。
- VAPID の鍵は初回に Durable Object が自分で作って保存します。ダッシュボードで秘密鍵を設定する必要はありません。

## API

| パス | 内容 |
|---|---|
| `GET /vapid` | VAPID 公開鍵 |
| `POST /sync` | `{id, sub?, tz, time, day, done, quota, free, streak, trigger}`。`sub` があれば登録・更新、なければ進み具合だけ更新 |
| `POST /test` | `{id}` すぐにテスト通知を送る |
| `POST /snooze` | `{id, min}` 指定の分数後にもう一度送る（今日の分が終わったら取り消し） |
| `POST /unsub` | `{id}` 登録を消す |

送信先は FCM・Apple・Mozilla・Windows のプッシュサービスだけを受け付けます。404・410 が返った購読は消し、10回続けて失敗したものも消します。

## デプロイ

Cloudflare の Workers Builds でこのリポジトリをつなぎ、ルートディレクトリを `push` にします。Worker 名は `dojo-push`（`wrangler.toml` の `name` と一致させる）。URL はアプリ側の `PUSH_BASE`（`https://dojo-push.checkes.workers.dev`）と合わせます。
