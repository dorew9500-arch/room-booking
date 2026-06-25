const express = require('express');
const router = express.Router();
const { requirePartner } = require('../middleware/auth');
const { query } = require('../database');

router.get('/', requirePartner, (req, res) => {
  const stores = query('SELECT * FROM stores WHERE is_active = 1 ORDER BY sort_order');
  const rooms = query('SELECT r.*, s.name as store_name FROM rooms r JOIN stores s ON r.store_id = s.id WHERE r.is_active = 1 ORDER BY r.store_id, r.sort_order');
  const durations = query('SELECT * FROM duration_options ORDER BY sort_order');
  res.render('partner/dashboard', { user: req.session.user, stores, rooms, durations });
});

module.exports = router;
