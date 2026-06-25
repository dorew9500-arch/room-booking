const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { requireAdmin, requireLogin } = require('../middleware/auth');
const { query, queryOne, run } = require('../database');

// 予約一覧
router.get('/bookings', requireLogin, (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  let bookings = query(`
    SELECT b.id, b.room_id, b.partner_id, b.client_name, b.start_at, b.duration, b.actual_duration,
           r.name as room_name, p.code as partner_code
    FROM bookings b
    JOIN rooms r ON b.room_id = r.id
    LEFT JOIN partners p ON b.partner_id = p.id
    WHERE substr(b.start_at, 1, 10) = ?
    ORDER BY b.start_at
  `, [date]);

  if (req.session.user.role === 'partner') {
    const myId = Number(req.session.user.id);
    bookings = bookings.map(b => {
      if (Number(b.partner_id) === myId) return b;
      return { id: b.id, room_id: b.room_id, room_name: b.room_name, start_at: b.start_at, duration: b.duration, actual_duration: b.actual_duration, is_other: true };
    });
  }
  res.json(bookings);
});

// 予約追加
router.post('/bookings', requireLogin, (req, res) => {
  const { room_id, start_at, duration, actual_duration, partner_code, client_name } = req.body;
  const startMin = toMin(start_at.slice(11, 16));
  const endMin = startMin + Number(duration);

  const existing = query("SELECT * FROM bookings WHERE room_id = ? AND substr(start_at,1,10) = ?", [room_id, start_at.slice(0,10)]);
  for (const b of existing) {
    const bStart = toMin(b.start_at.slice(11, 16));
    const bEnd = bStart + Number(b.duration);
    if (startMin < bEnd && endMin > bStart) {
      return res.status(409).json({ error: 'この時間帯はすでに予約が入っています' });
    }
  }

  let partner_id = null;
  if (partner_code) {
    const p = queryOne('SELECT id FROM partners WHERE code = ?', [partner_code]);
    if (p) partner_id = p.id;
  } else if (req.session.user.role === 'partner') {
    partner_id = req.session.user.id;
  }

  const result = run(
    'INSERT INTO bookings (room_id, partner_id, client_name, start_at, duration, actual_duration) VALUES (?,?,?,?,?,?)',
    [room_id, partner_id, client_name || null, start_at, duration, actual_duration || null]
  );
  res.json({ id: result.lastInsertRowid, message: '予約を追加しました' });
});

// 予約削除
router.delete('/bookings/:id', requireLogin, (req, res) => {
  const booking = queryOne('SELECT * FROM bookings WHERE id = ?', [req.params.id]);
  if (!booking) return res.status(404).json({ error: '予約が見つかりません' });
  if (req.session.user.role === 'partner' && Number(booking.partner_id) !== Number(req.session.user.id)) {
    return res.status(403).json({ error: '削除できません' });
  }
  run('DELETE FROM bookings WHERE id = ?', [req.params.id]);
  res.json({ message: '削除しました' });
});

// 部屋API
router.get('/admin/rooms', requireAdmin, (req, res) => res.json(query('SELECT * FROM rooms ORDER BY sort_order')));
router.post('/admin/rooms', requireAdmin, (req, res) => {
  try {
    const maxOrder = queryOne('SELECT MAX(sort_order) as m FROM rooms');
    const result = run('INSERT INTO rooms (name, sort_order) VALUES (?,?)', [req.body.name, (maxOrder?.m || 0) + 1]);
    res.json({ id: result.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: 'その部屋番号はすでに存在します' }); }
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

// 提携先API
router.get('/admin/partners', requireAdmin, (req, res) => res.json(query('SELECT id, code, name, login_id, is_active, created_at FROM partners ORDER BY code')));
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

// 利用時間API
router.get('/admin/durations', requireAdmin, (req, res) => res.json(query('SELECT * FROM duration_options ORDER BY sort_order')));
router.post('/admin/durations', requireAdmin, (req, res) => {
  const { label, duration, actual_duration } = req.body;
  const max = queryOne('SELECT MAX(sort_order) as m FROM duration_options');
  const result = run('INSERT INTO duration_options (label, duration, actual_duration, sort_order) VALUES (?,?,?,?)', [label, duration, actual_duration || null, (max?.m || 0) + 1]);
  res.json({ id: result.lastInsertRowid });
});
router.delete('/admin/durations/:id', requireAdmin, (req, res) => {
  run('DELETE FROM duration_options WHERE id = ?', [req.params.id]);
  res.json({ message: '削除しました' });
});

function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

module.exports = router;
