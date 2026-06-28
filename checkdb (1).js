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

  console.log('=== partner.js と同じ stores + tagIds 組み立て ===');
  const stores = db.query('SELECT * FROM stores WHERE is_active = 1 ORDER BY sort_order');
  stores.forEach(s => {
    const tags = db.query('SELECT tag_id FROM store_tags WHERE store_id = ?', [s.id]);
    s.tagIds = tags.map(t => t.tag_id);
  });
  // name は化けるので id と tagIds とその型だけ出す
  stores.forEach(s => {
    console.log(`store id=${s.id} tagIds=${JSON.stringify(s.tagIds)} typeof_first=${typeof s.tagIds[0]}`);
  });
  process.exit(0);
})();
