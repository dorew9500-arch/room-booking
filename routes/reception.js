const express = require('express');
const router = express.Router();
const { requireReception } = require('../middleware/auth');
const { query } = require('../database');

router.get('/', requireReception, (req, res) => {
  const storeId = req.session.user.store_id;
  const rooms = query('SELECT * FROM rooms WHERE store_id = ? AND is_active = 1 ORDER BY sort_order', [storeId]);
  const partners = query('SELECT * FROM partners WHERE is_active = 1 ORDER BY code');
  const durations = query('SELECT * FROM duration_options ORDER BY sort_order');
  res.render('reception/dashboard', { user: req.session.user, rooms, partners, durations });
});

module.exports = router;
