const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { requireAdmin, requireMaster, requireLogin } = require('../middleware/auth');
const { query, queryOne, run } = require('../database');

// ============ 予約API（共通）============

router.get('/bookings', requireLogin, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const user = req.session.user;

  let storeId = req.query.store_id;
  if (user.role === 'reception') storeId = user.store_id;

  let sql = `
    SELECT b.id, b.room_id, b.partner_id, b.client_name, b.start_at,
           b.course_minutes, b.block_minutes, b.extended, b.shifted,
           r.name as room_name, r.store_id, s.name as store_name, p.code as partner_code
    FROM bookings b
    JOIN rooms r ON b.room_id = r.id
    JOIN stores s ON r.store_id = s.id
    LEFT JOIN partners p ON b.partner_id = p.id
    WHERE substr(b.start_at, 1, 10) = ?`;
  const params = [date];
  if (storeId) { sql += ' AND r.store_id = ?'; params.push(storeId); }
  sql += ' ORDER BY b.start_at';

  let bookings = query(sql, params);

  if (user.role === 'partner') {
    const myId = Number(user.id);
    bookings = bookings.map(b => {
      if (Number(b.partner_id) === myId) return b;
      return { id: b.id, room_id: b.room_id, room_name: b.room_name, store_id: b.store_id, start_at: b.start_at, course_minutes: b.course_minutes, block_minutes: b.block_minutes, is_other: true };
    });
  }
  res.json(bookings);
});

router.post('/bookings', requireLogin, (req, res) => {
  const { room_id, start_at, course_minutes, partner_code, client_name } = req.body;
  const user = req.session.user;

  const room = queryOne('SELECT r.*, s.cleaning_minutes FROM rooms r JOIN stores s ON r.store_id = s.id WHERE r.id = ?', [room_id]);
  if (!room) return res.status(400).json({ error: '部屋が見つかりません' });
  if (room.blocked) return res.status(409).json({ error: `この部屋は現在利用できません${room.block_reason ? '（' + room.block_reason + '）' : ''}` });

  if (user.role === 'reception' && Number(room.store_id) !== Number(user.store_id)) {
    return res.status(403).json({ error: '他店舗の部屋は予約できません' });
  }

  const course = Number(course_minutes);
  const block = course + Number(room.cleaning_minutes);

  const startMin = toMin(start_at.slice(11, 16));
  const endMin = startMin + block;
  const existing = query("SELECT * FROM bookings WHERE room_id = ? AND substr(start_at,1,10) = ?", [room_id, start_at.slice(0,10)]);
  for (const b of existing) {
    const bStart = toMin(b.start_at.slice(11, 16));
    const bEnd = bStart + Number(b.block_minutes);
    if (startMin < bEnd && endMin > bStart) {
      return res.status(409).json({ error: 'この時間帯はすでに予約が入っています' });
    }
  }

  let partner_id = null;
  if (partner_code) {
    const p = queryOne('SELECT id FROM partners WHERE code = ?', [partner_code]);
    if (p) partner_id = p.id;
  } else if (user.role === 'partner') {
    partner_id = user.id;
  }

  const result = run(
    'INSERT INTO bookings (room_id, partner_id, client_name, start_at, course_minutes, block_minutes) VALUES (?,?,?,?,?,?)',
    [room_id, partner_id, client_name || null, start_at, course, block]
  );
  res.json({ id: result.lastInsertRowid, message: '予約を追加しました' });
});

router.delete('/bookings/:id', requireLogin, (req, res) => {
  const user = req.session.user;
  const booking = queryOne('SELECT b.*, r.store_id FROM bookings b JOIN rooms r ON b.room_id = r.id WHERE b.id = ?', [req.params.id]);
  if (!booking) return res.status(404).json({ error: '予約が見つかりません' });
  if (user.role === 'partner' && Number(booking.partner_id) !== Number(user.id)) {
    return res.status(403).json({ error: '削除できません' });
  }
  if (user.role === 'reception' && Number(booking.store_id) !== Number(user.store_id)) {
    return res.status(403).json({ error: '削除できません' });
  }
  run('DELETE FROM bookings WHERE id = ?', [req.params.id]);
  res.json({ message: '削除しました' });
});

// 予約の延長
router.post('/bookings/:id/extend', requireLogin, (req, res) => {
  const user = req.session.user;
  const addMinutes = Number(req.body.add_minutes);
  if (!addMinutes || addMinutes <= 0) return res.status(400).json({ error: '延長時間を指定してください' });

  const b = queryOne('SELECT b.*, r.store_id FROM bookings b JOIN rooms r ON b.room_id = r.id WHERE b.id = ?', [req.params.id]);
  if (!b) return res.status(404).json({ error: '予約が見つかりません' });
  if (user.role === 'partner' && Number(b.partner_id) !== Number(user.id)) return res.status(403).json({ error: '延長できません' });
  if (user.role === 'reception' && Number(b.store_id) !== Number(user.store_id)) return res.status(403).json({ error: '延長できません' });

  const newCourse = Number(b.course_minutes) + addMinutes;
  const newBlock = Number(b.block_minutes) + addMinutes;
  const startMin = toMin(b.start_at.slice(11, 16));
  const newEnd = startMin + newBlock;

  const others = query("SELECT * FROM bookings WHERE room_id = ? AND id != ? AND substr(start_at,1,10) = ?", [b.room_id, b.id, b.start_at.slice(0,10)]);
  for (const o of others) {
    const oStart = toMin(o.start_at.slice(11, 16));
    const oEnd = oStart + Number(o.block_minutes);
    if (startMin < oEnd && newEnd > oStart) {
      return res.status(409).json({ error: '次の予約が入っているため延長できません。お電話で調整してください。' });
    }
  }

  run('UPDATE bookings SET course_minutes = ?, block_minutes = ?, extended = 1 WHERE id = ?', [newCourse, newBlock, b.id]);
  res.json({ message: `${addMinutes}分延長しました` });
});

// 予約の開始時刻をずらす
router.post('/bookings/:id/shift', requireLogin, (req, res) => {
  const user = req.session.user;
  const newTime = req.body.new_time; // "HH:MM"
  if (!newTime || !/^\d{2}:\d{2}$/.test(newTime)) return res.status(400).json({ error: '時刻を指定してください' });

  const b = queryOne('SELECT b.*, r.store_id FROM bookings b JOIN rooms r ON b.room_id = r.id WHERE b.id = ?', [req.params.id]);
  if (!b) return res.status(404).json({ error: '予約が見つかりません' });
  if (user.role === 'partner' && Number(b.partner_id) !== Number(user.id)) return res.status(403).json({ error: '変更できません' });
  if (user.role === 'reception' && Number(b.store_id) !== Number(user.store_id)) return res.status(403).json({ error: '変更できません' });

  const datePart = b.start_at.slice(0, 10);
  const newStartMin = toMin(newTime);
  const newEnd = newStartMin + Number(b.block_minutes);

  const others = query("SELECT * FROM bookings WHERE room_id = ? AND id != ? AND substr(start_at,1,10) = ?", [b.room_id, b.id, datePart]);
  for (const o of others) {
    const oStart = toMin(o.start_at.slice(11, 16));
    const oEnd = oStart + Number(o.block_minutes);
    if (newStartMin < oEnd && newEnd > oStart) {
      return res.status(409).json({ error: '他の予約とぶつかるため変更できません。お電話で調整してください。' });
    }
  }

  run('UPDATE bookings SET start_at = ?, shifted = 1 WHERE id = ?', [`${datePart}T${newTime}`, b.id]);
  res.json({ message: '時間を変更しました' });
});

router.get('/durations', requireLogin, (req, res) => {
  res.json(query('SELECT * FROM duration_options ORDER BY sort_order'));
});

// エリア一覧（登録されているタグだけ・予約者の絞り込み用）
router.get('/areas', requireLogin, (req, res) => {
  res.json(query('SELECT DISTINCT t.id, t.name FROM area_tags t JOIN store_tags st ON t.id = st.tag_id ORDER BY t.sort_order'));
});

// ============ 管理者専用 ============

router.get('/admin/stores', requireAdmin, (req, res) => {
  const stores = query('SELECT * FROM stores ORDER BY sort_order');
  stores.forEach(s => {
    s.tags = query('SELECT t.id, t.name FROM store_tags st JOIN area_tags t ON st.tag_id = t.id WHERE st.store_id = ? ORDER BY t.sort_order', [s.id]);
  });
  res.json(stores);
});

// エリアタグ一覧
router.get('/admin/tags', requireAdmin, (req, res) => res.json(query('SELECT * FROM area_tags ORDER BY sort_order')));
// エリアタグ作成
router.post('/admin/tags', requireAdmin, (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'エリア名を入力してください' });
    const max = queryOne('SELECT MAX(sort_order) as m FROM area_tags');
    const result = run('INSERT INTO area_tags (name, sort_order) VALUES (?,?)', [name.trim(), (max?.m || 0) + 1]);
    res.json({ id: result.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: 'そのエリア名は既にあります' }); }
});
// エリアタグ削除（紐付けも消す）
router.delete('/admin/tags/:id', requireAdmin, (req, res) => {
  run('DELETE FROM store_tags WHERE tag_id = ?', [req.params.id]);
  run('DELETE FROM area_tags WHERE id = ?', [req.params.id]);
  res.json({ message: '削除しました' });
});
// 店舗にタグを付ける
router.post('/admin/stores/:id/tags', requireAdmin, (req, res) => {
  const { tag_id } = req.body;
  const exists = queryOne('SELECT id FROM store_tags WHERE store_id = ? AND tag_id = ?', [req.params.id, tag_id]);
  if (!exists) run('INSERT INTO store_tags (store_id, tag_id) VALUES (?,?)', [req.params.id, tag_id]);
  res.json({ message: '付与しました' });
});
// 店舗からタグを外す
router.delete('/admin/stores/:id/tags/:tagId', requireAdmin, (req, res) => {
  run('DELETE FROM store_tags WHERE store_id = ? AND tag_id = ?', [req.params.id, req.params.tagId]);
  res.json({ message: '外しました' });
});
router.post('/admin/stores', requireAdmin, (req, res) => {
  const { name, cleaning_minutes } = req.body;
  const max = queryOne('SELECT MAX(sort_order) as m FROM stores');
  const result = run('INSERT INTO stores (name, cleaning_minutes, sort_order) VALUES (?,?,?)', [name, cleaning_minutes || 5, (max?.m || 0) + 1]);
  res.json({ id: result.lastInsertRowid });
});
router.patch('/admin/stores/:id', requireAdmin, (req, res) => {
  const { name, cleaning_minutes, is_active } = req.body;
  if (name !== undefined) run('UPDATE stores SET name = ? WHERE id = ?', [name, req.params.id]);
  if (cleaning_minutes !== undefined) run('UPDATE stores SET cleaning_minutes = ? WHERE id = ?', [cleaning_minutes, req.params.id]);
  if (is_active !== undefined) run('UPDATE stores SET is_active = ? WHERE id = ?', [is_active, req.params.id]);
  res.json({ message: '更新しました' });
});
router.delete('/admin/stores/:id', requireAdmin, (req, res) => {
  const hasRoom = queryOne('SELECT id FROM rooms WHERE store_id = ?', [req.params.id]);
  if (hasRoom) { run('UPDATE stores SET is_active = 0 WHERE id = ?', [req.params.id]); return res.json({ message: '部屋があるため非表示にしました' }); }
  run('DELETE FROM stores WHERE id = ?', [req.params.id]);
  res.json({ message: '削除しました' });
});

router.get('/admin/receptions', requireAdmin, (req, res) => {
  res.json(query('SELECT rc.id, rc.store_id, rc.login_id, rc.is_active, s.name as store_name FROM reception_accounts rc JOIN stores s ON rc.store_id = s.id ORDER BY rc.store_id'));
});
router.post('/admin/receptions', requireMaster, (req, res) => {
  try {
    const { store_id, login_id, password } = req.body;
    const hash = bcrypt.hashSync(password, 10);
    const result = run('INSERT INTO reception_accounts (store_id, login_id, password_hash) VALUES (?,?,?)', [store_id, login_id, hash]);
    res.json({ id: result.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: 'ログインIDが重複しています' }); }
});
router.patch('/admin/receptions/:id', requireMaster, (req, res) => {
  const { password, is_active } = req.body;
  if (password) run('UPDATE reception_accounts SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(password, 10), req.params.id]);
  if (is_active !== undefined) run('UPDATE reception_accounts SET is_active = ? WHERE id = ?', [is_active, req.params.id]);
  res.json({ message: '更新しました' });
});
router.delete('/admin/receptions/:id', requireMaster, (req, res) => {
  run('DELETE FROM reception_accounts WHERE id = ?', [req.params.id]);
  res.json({ message: '削除しました' });
});

router.get('/admin/rooms', requireAdmin, (req, res) => {
  res.json(query('SELECT r.*, s.name as store_name FROM rooms r JOIN stores s ON r.store_id = s.id ORDER BY r.store_id, r.sort_order'));
});
router.post('/admin/rooms', requireAdmin, (req, res) => {
  const { store_id, name } = req.body;
  const max = queryOne('SELECT MAX(sort_order) as m FROM rooms WHERE store_id = ?', [store_id]);
  const result = run('INSERT INTO rooms (store_id, name, sort_order) VALUES (?,?,?)', [store_id, name, (max?.m || 0) + 1]);
  res.json({ id: result.lastInsertRowid });
});
router.patch('/admin/rooms/:id', requireAdmin, (req, res) => {
  const { is_active, memo } = req.body;
  if (is_active !== undefined) run('UPDATE rooms SET is_active = ? WHERE id = ?', [is_active, req.params.id]);
  if (memo !== undefined) run('UPDATE rooms SET memo = ? WHERE id = ?', [memo, req.params.id]);
  res.json({ message: '更新しました' });
});
router.post('/rooms/:id/block', requireLogin, (req, res) => {
  const role = req.session.user.role;
  if (role !== 'admin' && role !== 'reception') return res.status(403).json({ error: '権限がありません' });
  const { blocked, reason } = req.body;
  run('UPDATE rooms SET blocked = ?, block_reason = ? WHERE id = ?', [blocked ? 1 : 0, reason || '', req.params.id]);
  res.json({ message: blocked ? '利用不可にしました' : '利用可能に戻しました' });
});
router.post('/admin/rooms/reorder', requireAdmin, (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: '順番データが不正です' });
  order.forEach((roomId, i) => run('UPDATE rooms SET sort_order = ? WHERE id = ?', [i + 1, roomId]));
  res.json({ message: '並び順を保存しました' });
});
router.delete('/admin/rooms/:id', requireAdmin, (req, res) => {
  const hasBooking = queryOne('SELECT id FROM bookings WHERE room_id = ?', [req.params.id]);
  if (hasBooking) { run('UPDATE rooms SET is_active = 0 WHERE id = ?', [req.params.id]); return res.json({ message: '予約があるため非表示にしました' }); }
  run('DELETE FROM rooms WHERE id = ?', [req.params.id]);
  res.json({ message: '削除しました' });
});

router.get('/admin/partners', requireAdmin, (req, res) => res.json(query('SELECT id, code, name, login_id, is_active FROM partners ORDER BY code')));
router.post('/admin/partners', requireAdmin, (req, res) => {
  try {
    const { code, name, login_id, password } = req.body;
    const hash = bcrypt.hashSync(password, 10);
    const result = run('INSERT INTO partners (code, name, login_id, password_hash) VALUES (?,?,?,?)', [code, name, login_id, hash]);
    res.json({ id: result.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: 'コードまたはログインIDが重複しています' }); }
});
router.patch('/admin/partners/:id', requireAdmin, (req, res) => {
  const { is_active, password } = req.body;
  if (password) run('UPDATE partners SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(password, 10), req.params.id]);
  if (is_active !== undefined) run('UPDATE partners SET is_active = ? WHERE id = ?', [is_active, req.params.id]);
  res.json({ message: '更新しました' });
});
router.delete('/admin/partners/:id', requireAdmin, (req, res) => {
  run('DELETE FROM partners WHERE id = ?', [req.params.id]);
  res.json({ message: '削除しました' });
});

router.post('/admin/durations', requireAdmin, (req, res) => {
  const { minutes } = req.body;
  const max = queryOne('SELECT MAX(sort_order) as m FROM duration_options');
  const result = run('INSERT INTO duration_options (minutes, sort_order) VALUES (?,?)', [minutes, (max?.m || 0) + 1]);
  res.json({ id: result.lastInsertRowid });
});
router.delete('/admin/durations/:id', requireAdmin, (req, res) => {
  run('DELETE FROM duration_options WHERE id = ?', [req.params.id]);
  res.json({ message: '削除しました' });
});

function toMin(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }

module.exports = router;
