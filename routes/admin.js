const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { query } = require('../database');

router.get('/', requireAdmin, (req, res) => {
  const rooms = query('SELECT * FROM rooms WHERE is_active = 1 ORDER BY sort_order');
  const partners = query('SELECT * FROM partners WHERE is_active = 1 ORDER BY code');
  const durations = query('SELECT * FROM duration_options ORDER BY sort_order');
  res.render('admin/dashboard', { user: req.session.user, rooms, partners, durations });
});

router.get('/rooms', requireAdmin, (req, res) => {
  const rooms = query('SELECT * FROM rooms ORDER BY sort_order');
  res.render('admin/rooms', { user: req.session.user, rooms });
});

router.get('/partners', requireAdmin, (req, res) => {
  const partners = query('SELECT * FROM partners ORDER BY code');
  res.render('admin/partners', { user: req.session.user, partners });
});

module.exports = router;
