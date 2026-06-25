const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { queryOne } = require('../database');

router.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect(redirectFor(req.session.user.role));
  }
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const { login_id, password } = req.body;

  // 管理者
  const admin = queryOne('SELECT * FROM admins WHERE login_id = ?', [login_id]);
  if (admin && bcrypt.compareSync(password, admin.password_hash)) {
    req.session.user = { id: admin.id, role: 'admin', login_id: admin.login_id };
    return res.redirect('/admin');
  }

  // 受付アカウント（店舗固定）
  const reception = queryOne('SELECT r.*, s.name as store_name FROM reception_accounts r JOIN stores s ON r.store_id = s.id WHERE r.login_id = ? AND r.is_active = 1', [login_id]);
  if (reception && bcrypt.compareSync(password, reception.password_hash)) {
    req.session.user = { id: reception.id, role: 'reception', login_id: reception.login_id, store_id: reception.store_id, store_name: reception.store_name };
    return res.redirect('/reception');
  }

  // 名前（提携先）
  const partner = queryOne('SELECT * FROM partners WHERE login_id = ? AND is_active = 1', [login_id]);
  if (partner && bcrypt.compareSync(password, partner.password_hash)) {
    req.session.user = { id: partner.id, role: 'partner', login_id: partner.login_id, code: partner.code };
    return res.redirect('/partner');
  }

  res.render('login', { error: 'IDまたはパスワードが正しくありません' });
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

function redirectFor(role) {
  if (role === 'admin') return '/admin';
  if (role === 'reception') return '/reception';
  return '/partner';
}

module.exports = router;
