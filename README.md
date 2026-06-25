# レンタルルーム予約管理システム

管理者と提携先スタッフが、電話なしでリアルタイムに部屋の空き確認・予約ができるWebアプリ。

## 機能

- 管理者ダッシュボード（左：時系列リスト / 右：空きグリッド）
- 空きグリッドのセルをクリックして予約追加
- 利用時間はテンプレボタン or 手入力
- 名前はコード（A/B/C）プルダウン or 客名手入力
- 清掃5分は自動でグレー表示
- 部屋の動的追加・削除
- 提携先管理（コードと実店名を分離、実店名は管理者のみ閲覧）
- 30秒ごとの自動リフレッシュ

## セットアップ

```bash
npm install
node server.js
```

→ http://localhost:3000

初期ログイン: `admin` / `admin1234`（初回ログイン後に変更推奨）

## VPSでの本番運用

```bash
# PM2で常駐化
npm install -g pm2
pm2 start server.js --name room-booking
pm2 startup
pm2 save
```

## 技術構成

- Node.js + Express
- sql.js（純粋JS版SQLite。ネイティブビルド不要）
- express-session（メモリストア）
- bcryptjs（パスワードハッシュ）
- EJS（テンプレート）

## データ

`data/booking.db` にSQLite形式で保存される。バックアップはこのファイルをコピーするだけ。

## .env

```
PORT=3000
SESSION_SECRET=ここをランダムな文字列に変更
NODE_ENV=production
```

## 注意

- 本番環境では必ず SESSION_SECRET を変更すること
- 本番では nginx + Let's Encrypt でHTTPS化を推奨
- セッションはメモリストアのため、サーバー再起動でログアウトされる（予約データは保持される）
