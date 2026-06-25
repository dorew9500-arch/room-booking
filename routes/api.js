const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { requireAdmin, requireLogin } = require('../middleware/auth');
const { query, queryOne, run } = require('../database');

// ============ 予約API（共通）============

router.get('/bookings', requireLogin, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const user = req.session.user;

  let storeId = req.query.store_id;
  if (user.role === 'reception') storeId = user.store_id;

  let sql = `
    SELECT b.id, b.room_id, b.partner_id, b.client_name, b.start_at,
           b.course_minutes, b.block_minutes,
           r.name as room_name, r.store_id, p.code as partner_code
    FROM bookings b
    JOIN rooms r ON b.room_id = r.id
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

router.get('/durations', requireLogin, (req, res) => {
  res.json(query('SELECT * FROM duration_options ORDER BY sort_order'));
});

// ============ 管理者専用 ============

router.get('/admin/stores', requireAdmin, (req, res) => res.json(query('SELECT * FROM stores ORDER BY sort_order')));
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
router.post('/admin/receptions', requireAdmin, (req, res) => {
  try {
    const { store_id, login_id, password } = req.body;
    const hash = bcrypt.hashSync(password, 10);
    const result = run('INSERT INTO reception_accounts (store_id, login_id, password_hash) VALUES (?,?,?)', [store_id, login_id, hash]);
    res.json({ id: result.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: 'ログインIDが重複しています' }); }
});
router.patch('/admin/receptions/:id', requireAdmin, (req, res) => {
  const { password, is_active } = req.body;
  if (password) run('UPDATE reception_accounts SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(password, 10), req.params.id]);
  if (is_active !== undefined) run('UPDATE reception_accounts SET is_active = ? WHERE id = ?', [is_active, req.params.id]);
  res.json({ message: '更新しました' });
});
router.delete('/admin/receptions/:id', requireAdmin, (req, res) => {
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
  const { is_active } = req.body;
  if (is_active !== undefined) run('UPDATE rooms SET is_active = ? WHERE id = ?', [is_active, req.params.id]);
  res.json({ message: '更新しました' });
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
