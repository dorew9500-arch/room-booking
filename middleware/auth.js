function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  res.redirect('/login');
}

function requirePartner(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'partner') {
    return next();
  }
  res.redirect('/login');
}

function requireLogin(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  res.redirect('/login');
}

module.exports = { requireAdmin, requirePartner, requireLogin };
