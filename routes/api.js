const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { requireAdmin, requireMaster, requireLogin, requireReception } = require('../middleware/auth');
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
           r.name as room_name, r.store_id, r.blocked as room_blocked, r.block_reason,
           s.name as store_name, p.code as partner_code
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
      return { id: b.id, room_id: b.room_id, room_name: b.room_name, store_id: b.store_id, room_blocked: b.room_blocked, block_reason: b.block_reason, start_at: b.start_at, course_minutes: b.course_minutes, block_minutes: b.block_minutes, is_other: true };
    });
  }
  res.json(bookings);
});

// 新規予約の通知検知用：自分（自店舗/自分）の予約IDだけを軽量に返す。
// 過去は通知不要なので今日以降に限定。start_atも返し、新着の中身表示に使う。
router.get('/booking-ids', requireLogin, (req, res) => {
  const user = req.session.user;
  const today = new Date().toISOString().slice(0, 10);
  let sql = `
    SELECT b.id, b.start_at, b.course_minutes, b.extended, b.shifted,
           r.name as room_name, r.store_id, b.partner_id
    FROM bookings b
    JOIN rooms r ON b.room_id = r.id
    WHERE substr(b.start_at, 1, 10) >= ?`;
  const params = [today];
  if (user.role === 'reception') { sql += ' AND r.store_id = ?'; params.push(user.store_id); }
  if (user.role === 'partner') { sql += ' AND b.partner_id = ?'; params.push(user.id); }
  sql += ' ORDER BY b.id';
  res.json(query(sql, params));
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

  // 予約者(partner)のみ：過去の時間は予約不可（5分の余裕を持たせる）。受付・管理者は過去もOK。
  if (user.role === 'partner') {
    const now = new Date();
    const startDt = new Date(start_at); // "YYYY-MM-DDTHH:MM" をローカル時刻として解釈
    if (!isNaN(startDt.getTime()) && startDt.getTime() < now.getTime() - 5 * 60 * 1000) {
      return res.status(400).json({ error: '過去の時間は予約できません' });
    }
  }

  const course = Number(course_minutes);
  const block = course + Number(room.cleaning_minutes);

  // 未振り分け部屋（is_holding）は「部屋も時間も仮」の待機列なので、重なり判定はしない。
  // 同じ待機列に複数の予約が同時刻で並んでも良い（あとでスタッフが各部屋へ振り分ける）。
  if (!room.is_holding) {
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
  // 過去（昨日以前）の予約は管理者のみ削除可。受付・予約者は不可。
  if (user.role !== 'admin') {
    const bookingDate = String(booking.start_at).slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (bookingDate < today) {
      return res.status(403).json({ error: '過去の予約は管理者のみ削除できます' });
    }
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

// 予約を同じ店舗の別の部屋へ振り替える（受付・管理者・予約者が使える・空き判定つき）
router.post('/bookings/:id/transfer', requireLogin, (req, res) => {
  const user = req.session.user;
  const toRoomId = Number(req.body.to_room_id);
  if (!toRoomId) return res.status(400).json({ error: '振り替え先の部屋を指定してください' });

  const b = queryOne('SELECT b.*, r.store_id FROM bookings b JOIN rooms r ON b.room_id = r.id WHERE b.id = ?', [req.params.id]);
  if (!b) return res.status(404).json({ error: '予約が見つかりません' });

  // 権限：予約者は自分の予約のみ／受付は自店のみ
  if (user.role === 'partner' && Number(b.partner_id) !== Number(user.id)) return res.status(403).json({ error: '振り替えできません' });
  if (user.role === 'reception' && Number(b.store_id) !== Number(user.store_id)) return res.status(403).json({ error: '振り替えできません' });

  if (Number(toRoomId) === Number(b.room_id)) return res.status(400).json({ error: '同じ部屋です' });

  // 振り替え先の部屋を取得・検証
  const toRoom = queryOne('SELECT r.*, s.cleaning_minutes FROM rooms r JOIN stores s ON r.store_id = s.id WHERE r.id = ?', [toRoomId]);
  if (!toRoom) return res.status(404).json({ error: '振り替え先の部屋が見つかりません' });
  if (Number(toRoom.store_id) !== Number(b.store_id)) return res.status(400).json({ error: '同じ店舗の部屋にのみ振り替えできます' });
  if (toRoom.blocked) return res.status(409).json({ error: `振り替え先は利用不可です${toRoom.block_reason ? '（' + toRoom.block_reason + '）' : ''}` });
  if (user.role === 'reception' && Number(toRoom.store_id) !== Number(user.store_id)) return res.status(403).json({ error: '他店舗の部屋には振り替えできません' });

  // 振り替え先での清掃込み所要時間で空き判定（コースは据え置き、清掃は振り替え先店舗の設定に従う）
  const newBlock = Number(b.course_minutes) + Number(toRoom.cleaning_minutes);
  const startMin = toMin(b.start_at.slice(11, 16));
  const newEnd = startMin + newBlock;
  const datePart = b.start_at.slice(0, 10);
  const others = query("SELECT * FROM bookings WHERE room_id = ? AND substr(start_at,1,10) = ?", [toRoomId, datePart]);
  const conflicts = [];
  for (const o of others) {
    const oStart = toMin(o.start_at.slice(11, 16));
    const oEnd = oStart + Number(o.block_minutes);
    if (startMin < oEnd && newEnd > oStart) conflicts.push(o);
  }
  // 重なりがある場合：force指定が無ければ「重なっている」ことを伝えて確認を促す。
  // forceが来たら（＝スタッフが承知の上で）そのまま移動する。利用不可(blocked)は上で既に弾いている。
  const force = req.body.force === true || req.body.force === 'true';
  if (conflicts.length && !force) {
    const first = conflicts[0];
    const label = `${first.start_at.slice(11, 16)}〜（${first.course_minutes}分）`;
    return res.status(409).json({
      error: '振り替え先のその時間帯は埋まっています',
      conflict: true,
      conflict_count: conflicts.length,
      conflict_label: label,
      to_room_name: toRoom.name
    });
  }

  run('UPDATE bookings SET room_id = ?, block_minutes = ? WHERE id = ?', [toRoomId, newBlock, b.id]);
  res.json({ message: `${toRoom.name} に振り替えました`, forced: conflicts.length > 0 });
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
  if (role === 'reception') {
    const room = queryOne('SELECT store_id FROM rooms WHERE id = ?', [req.params.id]);
    if (!room) return res.status(404).json({ error: '部屋が見つかりません' });
    if (Number(room.store_id) !== Number(req.session.user.store_id)) return res.status(403).json({ error: '自分の店舗の部屋ではありません' });
  }
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

// ============ 受付用 部屋管理（自店のみ）============
// 対象の部屋が受付の自店舗かを検証するヘルパー。OKならroomを返し、NGならnull。
function receptionRoomGuard(req, res) {
  const room = queryOne('SELECT * FROM rooms WHERE id = ?', [req.params.id]);
  if (!room) { res.status(404).json({ error: '部屋が見つかりません' }); return null; }
  if (Number(room.store_id) !== Number(req.session.user.store_id)) {
    res.status(403).json({ error: '自分の店舗の部屋ではありません' }); return null;
  }
  return room;
}

// 自店の部屋一覧
router.get('/reception/rooms', requireReception, (req, res) => {
  res.json(query('SELECT * FROM rooms WHERE store_id = ? ORDER BY sort_order', [req.session.user.store_id]));
});
// 自店に部屋追加（store_idはセッションから強制。リクエストのstore_idは無視）
router.post('/reception/rooms', requireReception, (req, res) => {
  const { name } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: '部屋番号を入力してください' });
  const storeId = req.session.user.store_id;
  const max = queryOne('SELECT MAX(sort_order) as m FROM rooms WHERE store_id = ?', [storeId]);
  const result = run('INSERT INTO rooms (store_id, name, sort_order) VALUES (?,?,?)', [storeId, String(name).trim(), (max?.m || 0) + 1]);
  res.json({ id: result.lastInsertRowid });
});
// 名前/メモ/有効無効の更新（自店のみ）
router.patch('/reception/rooms/:id', requireReception, (req, res) => {
  if (!receptionRoomGuard(req, res)) return;
  const { name, memo, is_active } = req.body;
  if (name !== undefined) { if (!String(name).trim()) return res.status(400).json({ error: '部屋番号を入力してください' }); run('UPDATE rooms SET name = ? WHERE id = ?', [String(name).trim(), req.params.id]); }
  if (memo !== undefined) run('UPDATE rooms SET memo = ? WHERE id = ?', [memo, req.params.id]);
  if (is_active !== undefined) run('UPDATE rooms SET is_active = ? WHERE id = ?', [is_active, req.params.id]);
  res.json({ message: '更新しました' });
});
// 並べ替え（自店の部屋のみ受け付ける）
router.post('/reception/rooms/reorder', requireReception, (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: '順番データが不正です' });
  const storeId = Number(req.session.user.store_id);
  order.forEach((roomId, i) => {
    const r = queryOne('SELECT store_id FROM rooms WHERE id = ?', [roomId]);
    if (r && Number(r.store_id) === storeId) run('UPDATE rooms SET sort_order = ? WHERE id = ?', [i + 1, roomId]);
  });
  res.json({ message: '並び順を保存しました' });
});
// 削除（自店のみ。予約があれば非表示）
router.delete('/reception/rooms/:id', requireReception, (req, res) => {
  if (!receptionRoomGuard(req, res)) return;
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

// ============ チャット（予約者↔店舗）============
// スレッドの単位は (partner_id, store_id, chat_date)。「その日のやり取り」で1本。
// - partner: 自分(partner_id)が、指定store_idの店とやり取り
// - reception: 自店(store_id固定)が、指定partner_idの予約者とやり取り
// - admin: 任意の store_id × partner_id を指定して閲覧・送信

function today() { return new Date().toISOString().slice(0, 10); }

// リクエストから (partnerId, storeId, role, label) を解決。権限も判定。
function resolveChatCtx(req) {
  const u = req.session.user;
  const date = (req.query.date || req.body?.date || today());
  if (u.role === 'partner') {
    const storeId = Number(req.query.store_id || req.body?.store_id);
    if (!storeId) return { error: '店舗が指定されていません' };
    return { partnerId: u.id, storeId, date, role: 'partner', label: u.code || '予約者', side: 'partner' };
  }
  if (u.role === 'reception') {
    const partnerId = Number(req.query.partner_id || req.body?.partner_id);
    if (!partnerId) return { error: '予約者が指定されていません' };
    return { partnerId, storeId: u.store_id, date, role: 'reception', label: (u.store_name || '店舗') + '受付', side: 'store' };
  }
  if (u.role === 'admin') {
    const storeId = Number(req.query.store_id || req.body?.store_id);
    const partnerId = Number(req.query.partner_id || req.body?.partner_id);
    if (!storeId || !partnerId) return { error: '店舗と予約者の指定が必要です' };
    const st = queryOne('SELECT name FROM stores WHERE id = ?', [storeId]);
    return { partnerId, storeId, date, role: 'admin', label: (st?.name || '店舗') + '管理', side: 'store' };
  }
  return { error: '権限がありません' };
}

// スレッドのメッセージ取得（同時に、自分側の未読を既読化）
router.get('/chat/messages', requireLogin, (req, res) => {
  const c = resolveChatCtx(req);
  if (c.error) return res.status(400).json({ error: c.error });
  const msgs = query(
    'SELECT * FROM chat_messages WHERE partner_id = ? AND store_id = ? AND chat_date = ? ORDER BY id ASC',
    [c.partnerId, c.storeId, c.date]
  );
  // 開いた側の未読を既読にする
  if (c.side === 'partner') {
    run('UPDATE chat_messages SET read_by_partner = 1 WHERE partner_id = ? AND store_id = ? AND chat_date = ? AND read_by_partner = 0', [c.partnerId, c.storeId, c.date]);
  } else {
    run('UPDATE chat_messages SET read_by_store = 1 WHERE partner_id = ? AND store_id = ? AND chat_date = ? AND read_by_store = 0', [c.partnerId, c.storeId, c.date]);
  }
  res.json(msgs.map(m => ({
    id: m.id, body: m.body, sender_role: m.sender_role, sender_label: m.sender_label,
    mine: m.sender_role === c.role || (c.side === 'store' && (m.sender_role === 'reception' || m.sender_role === 'admin')),
    at: m.created_at
  })));
});

// メッセージ送信
router.post('/chat/messages', requireLogin, (req, res) => {
  const c = resolveChatCtx(req);
  if (c.error) return res.status(400).json({ error: c.error });
  const body = (req.body.body || '').toString().trim();
  if (!body) return res.status(400).json({ error: 'メッセージが空です' });
  if (body.length > 500) return res.status(400).json({ error: 'メッセージが長すぎます（500文字まで）' });
  // 送信側は既読、相手側は未読で入れる
  const readP = c.side === 'partner' ? 1 : 0;
  const readS = c.side === 'store' ? 1 : 0;
  const r = run(
    `INSERT INTO chat_messages (partner_id, store_id, chat_date, sender_role, sender_label, body, read_by_partner, read_by_store)
     VALUES (?,?,?,?,?,?,?,?)`,
    [c.partnerId, c.storeId, c.date, c.role, c.label, body, readP, readS]
  );
  res.json({ id: r.lastInsertRowid, message: '送信しました' });
});

// 未読サマリー（バッジ用）。ポーリングで叩く。
// partner: 自分宛(店舗→自分)の未読を、店舗ごとに集計
// reception: 自店宛(予約者→店舗)の未読を、予約者ごとに集計
// admin: 店舗宛の未読を、store×partnerごとに集計
router.get('/chat/unread', requireLogin, (req, res) => {
  const u = req.session.user;
  const date = req.query.date || today();
  if (u.role === 'partner') {
    const rows = query(
      `SELECT store_id, COUNT(*) as cnt FROM chat_messages
       WHERE partner_id = ? AND chat_date = ? AND sender_role IN ('reception','admin') AND read_by_partner = 0
       GROUP BY store_id`, [u.id, date]);
    return res.json({ total: rows.reduce((s, r) => s + r.cnt, 0), by: rows.map(r => ({ store_id: r.store_id, cnt: r.cnt })) });
  }
  if (u.role === 'reception') {
    const rows = query(
      `SELECT partner_id, COUNT(*) as cnt FROM chat_messages
       WHERE store_id = ? AND chat_date = ? AND sender_role = 'partner' AND read_by_store = 0
       GROUP BY partner_id`, [u.store_id, date]);
    return res.json({ total: rows.reduce((s, r) => s + r.cnt, 0), by: rows.map(r => ({ partner_id: r.partner_id, cnt: r.cnt })) });
  }
  if (u.role === 'admin') {
    const rows = query(
      `SELECT store_id, partner_id, COUNT(*) as cnt FROM chat_messages
       WHERE chat_date = ? AND sender_role = 'partner' AND read_by_store = 0
       GROUP BY store_id, partner_id`, [date]);
    return res.json({ total: rows.reduce((s, r) => s + r.cnt, 0), by: rows.map(r => ({ store_id: r.store_id, partner_id: r.partner_id, cnt: r.cnt })) });
  }
  res.json({ total: 0, by: [] });
});

// 受付・管理者が「今チャット相手になり得る予約者」の一覧（その日その店に予約がある予約者）
router.get('/chat/partners', requireLogin, (req, res) => {
  const u = req.session.user;
  const date = req.query.date || today();
  let storeId;
  if (u.role === 'reception') storeId = u.store_id;
  else if (u.role === 'admin') storeId = Number(req.query.store_id);
  else return res.status(403).json({ error: '権限がありません' });
  if (!storeId) return res.json([]);
  // その日その店の予約から予約者を拾う＋既にチャットがある予約者も含める
  const rows = query(
    `SELECT DISTINCT p.id, p.code, p.name FROM partners p
     WHERE p.id IN (
       SELECT b.partner_id FROM bookings b JOIN rooms r ON b.room_id = r.id
       WHERE r.store_id = ? AND substr(b.start_at,1,10) = ? AND b.partner_id IS NOT NULL
       UNION
       SELECT partner_id FROM chat_messages WHERE store_id = ? AND chat_date = ?
     ) ORDER BY p.code`, [storeId, date, storeId, date]);
  res.json(rows);
});

module.exports = router;
