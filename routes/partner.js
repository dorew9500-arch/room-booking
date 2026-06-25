const express = require('express');
const router = express.Router();
const { requirePartner } = require('../middleware/auth');
const { query } = require('../database');

router.get('/', requirePartner, (req, res) => {
  const rooms = query('SELECT * FROM rooms WHERE is_active = 1 ORDER BY sort_order');
  const durations = query('SELECT * FROM duration_options ORDER BY sort_order');
  res.render('partner/dashboard', { user: req.session.user, rooms, durations });
});

module.exports = router;
