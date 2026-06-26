function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  res.redirect('/login');
}
function requireMaster(req, res, next) {
  if (req.session?.user?.role === 'admin' && req.session.user.is_master) return next();
  res.status(403).json({ error: 'この操作はマスターアカウントのみ可能です' });
}
function requireReception(req, res, next) {
  if (req.session?.user?.role === 'reception') return next();
  res.redirect('/login');
}
function requirePartner(req, res, next) {
  if (req.session?.user?.role === 'partner') return next();
  res.redirect('/login');
}
function requireLogin(req, res, next) {
  if (req.session?.user) return next();
  res.redirect('/login');
}
module.exports = { requireAdmin, requireMaster, requireReception, requirePartner, requireLogin };
