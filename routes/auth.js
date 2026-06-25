const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { queryOne } = require('../database');

router.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/partner');
  }
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  const { login_id, password } = req.body;
  const admin = queryOne('SELECT * FROM admins WHERE login_id = ?', [login_id]);
  if (admin && bcrypt.compareSync(password, admin.password_hash)) {
    req.session.user = { id: admin.id, role: 'admin', login_id: admin.login_id };
    return res.redirect('/admin');
  }
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

module.exports = router;
