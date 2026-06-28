// DB状態確認用スクリプト（使い捨て）
// 使い方: node checkdb.js
const db = require('./database');

(async () => {
  await db.initDB();
  console.log('=== area_tags ===');
  console.log(JSON.stringify(db.query('SELECT * FROM area_tags'), null, 2));
  console.log('=== store_tags ===');
  console.log(JSON.stringify(db.query('SELECT * FROM store_tags'), null, 2));
  console.log('=== stores (active) ===');
  console.log(JSON.stringify(db.query('SELECT id,name,is_active FROM stores WHERE is_active=1'), null, 2));
  console.log('=== partner.js と同じクエリ（areas） ===');
  console.log(JSON.stringify(db.query('SELECT DISTINCT t.id, t.name FROM area_tags t JOIN store_tags st ON t.id = st.tag_id ORDER BY t.sort_order'), null, 2));
  process.exit(0);
})();
