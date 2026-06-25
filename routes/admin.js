const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { query } = require('../database');

router.get('/', requireAdmin, (req, res) => {
  const stores = query('SELECT * FROM stores WHERE is_active = 1 ORDER BY sort_order');
  const rooms = query('SELECT r.*, s.name as store_name FROM rooms r JOIN stores s ON r.store_id = s.id WHERE r.is_active = 1 ORDER BY r.store_id, r.sort_order');
  const partners = query('SELECT * FROM partners WHERE is_active = 1 ORDER BY code');
  const durations = query('SELECT * FROM duration_options ORDER BY sort_order');
  res.render('admin/dashboard', { user: req.session.user, stores, rooms, partners, durations });
});

router.get('/stores', requireAdmin, (req, res) => {
  res.render('admin/stores', { user: req.session.user });
});
router.get('/rooms', requireAdmin, (req, res) => {
  res.render('admin/rooms', { user: req.session.user });
});
router.get('/partners', requireAdmin, (req, res) => {
  res.render('admin/partners', { user: req.session.user });
});

module.exports = router;
