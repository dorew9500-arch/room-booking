const express = require('express');
const router = express.Router();
const { requirePartner } = require('../middleware/auth');
const { query } = require('../database');

router.get('/', requirePartner, (req, res) => {
  const stores = query('SELECT * FROM stores WHERE is_active = 1 ORDER BY sort_order');
  stores.forEach(s => {
    const tags = query('SELECT tag_id FROM store_tags WHERE store_id = ?', [s.id]);
    s.tagIds = tags.map(t => t.tag_id);
  });
  const rooms = query('SELECT r.*, s.name as store_name FROM rooms r JOIN stores s ON r.store_id = s.id WHERE r.is_active = 1 ORDER BY r.store_id, r.sort_order');
  const durations = query('SELECT * FROM duration_options ORDER BY sort_order');
  const areas = query('SELECT DISTINCT t.id, t.name FROM area_tags t JOIN store_tags st ON t.id = st.tag_id ORDER BY t.sort_order');
  res.render('partner/dashboard', { user: req.session.user, stores, rooms, durations, areas });
});

module.exports = router;
