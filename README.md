# リーディング道場

TOEIC Reading（Part 5〜7）を、1日決まった回数だけ解く練習アプリです。ホーム画面に追加でき、オフラインでも動きます。

- 公開先: https://oniikazu0902-source.github.io/reading-dojo/
- 問題はすべてオリジナルです（95問、日本語の解説つき）。
- 頻出の192語を、例文つきの4択で練習できます（1日3セット、30語まで）。
- 記録は端末のブラウザ（localStorage）に保存されます。

## 構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | アプリ本体（画面・問題データ・ロジックを1ファイルに収めています） |
| `manifest.webmanifest` | ホーム画面に追加するための設定 |
| `sw.js` | オフライン用のキャッシュ |
| `icon-*.png`, `apple-touch-icon.png` | アイコン |

ビルドは不要です。`main` に入った内容がそのまま GitHub Pages で配信されます。

## 問題を追加するとき

`index.html` の `Q5`（Part 5）と `SETS`（Part 6・7）に足します。選択肢は先頭を正解にしてください（表示のときに並べ替えます）。
問題IDは単元ごとの連番なので、**既存の問題の途中に挿入せず、単元の最後に足してください**（途中に入れると学習記録がずれます）。

`WORDS`（単語）も同じで、末尾に足してください。

## 単語データの出典とライセンス

単語の選定と並び順は [TOEIC Service List 1.2](https://www.newgeneralservicelist.com/toeic-service-list)（Browne, C. & Culligan, B., 2016）の頻度順位に基づきます。同リストは [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) で公開されています。日本語訳と例文は独自に作成しました。`index.html` 内の `WORDS` の単語データは、同じ CC BY-SA 4.0 で利用できます。
