// 孤児 store_tags を掃除する（使い捨て）
// area_tags に存在しない tag_id を指す store_tags を削除する
const db = require('./database');
(async () => {
  await db.initDB();
  console.log('--- 掃除前 ---');
  console.log('store_tags=' + JSON.stringify(db.query('SELECT * FROM store_tags')));
  console.log('area_tags=' + JSON.stringify(db.query('SELECT id,name FROM area_tags')));

  // 孤児（対応するarea_tagが無いstore_tag）を特定して削除
  const orphans = db.query(
    'SELECT st.id FROM store_tags st LEFT JOIN area_tags t ON st.tag_id = t.id WHERE t.id IS NULL'
  );
  console.log(`孤児 store_tags 件数: ${orphans.length}`);
  orphans.forEach(o => {
    db.run('DELETE FROM store_tags WHERE id = ?', [o.id]);
  });

  console.log('--- 掃除後 ---');
  console.log('store_tags=' + JSON.stringify(db.query('SELECT * FROM store_tags')));
  const stores = db.query('SELECT * FROM stores WHERE is_active = 1 ORDER BY sort_order');
  stores.forEach(s => {
    const tags = db.query('SELECT tag_id FROM store_tags WHERE store_id = ?', [s.id]);
    console.log(`store id=${s.id} tagIds=${JSON.stringify(tags.map(t => t.tag_id))}`);
  });
  console.log('完了');
  process.exit(0);
})();
