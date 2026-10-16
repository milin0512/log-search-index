# ログ検索インデックス 運用ルール

## 取扱説明書の更新ルール（2026-10-17追加、Mikoto指示）

- 機能追加・仕様変更・画面の文言変更など、ユーザーから見える改修を行ったときは、**常に同じコミット・プッシュで取扱説明書も更新する**こと。取扱説明書は常に公開中のツールの最新状態に対応していなければならない。
  - 更新対象は **`取扱説明書.md` と `manual.html`（公開ページ: https://milin0512.github.io/log-search-index/manual.html）の両方**。片方だけ直すと食い違う。
  - `manual.html`は`取扱説明書.md`から変換して作る。変換スクリプトとテンプレートは `.claude/manual/`（gitignore対象のためリポジトリには含まれない）にある。`.md`を直したら、次のコマンドで`manual.html`を作り直す（テンプレートの「最終更新」の日付も、その日の日付に直してから実行する）。
    ```
    powershell -NoProfile -ExecutionPolicy Bypass -File .claude/manual/md2manual.ps1 -Md 取扱説明書.md -Template .claude/manual/manual.template.html -Out manual.html
    ```
    - `md2manual.ps1`はASCII文字だけで書くこと（Windows PowerShell 5.1はBOMなしUTF-8のスクリプトを誤読するため）。
    - `.claude/manual/`が見つからない場合は、`manual.html`を直接編集し、`.md`と同じ内容になるようにする。
  - 記述はコード（app.js・index.html）の実際の挙動と照らし合わせて書き、確認できない内容は書かない。
  - 内部的な修正のみ（リファクタリング、見た目・挙動が変わらない不具合修正等）で説明書に影響がない場合は更新不要。その場合も、影響がないことを確認したうえで判断する。

## キャッシュ運用ルール

- `app.js` または `style.css` を変更するコミットでは、`index.html` が読み込んでいるクエリ文字列（`app.js?v=N` / `style.css?v=N`）の番号も必ず一緒に上げること（CClogと同じ。iPhone/iPadのSafariが古い版を使い続けるのを防ぐため）。
