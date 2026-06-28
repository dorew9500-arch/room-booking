// エリア紐付けの現状確認（使い捨て）
const db = require('./database');
(async () => {
  await db.initDB();
  const stores = db.query('SELECT * FROM stores WHERE is_active = 1 ORDER BY sort_order');
  stores.forEach(s => {
    const tags = db.query('SELECT tag_id FROM store_tags WHERE store_id = ?', [s.id]);
    console.log(`store id=${s.id} tagIds=${JSON.stringify(tags.map(t => t.tag_id))}`);
  });
  console.log('area_tags=' + JSON.stringify(db.query('SELECT id,name FROM area_tags ORDER BY sort_order')));
  console.log('store_tags(raw)=' + JSON.stringify(db.query('SELECT * FROM store_tags')));
  process.exit(0);
})();
