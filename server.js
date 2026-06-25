require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const path = require('path');
const { initDB } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

async function start() {
  await initDB();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.use(session({
    store: new MemoryStore({ checkPeriod: 86400000 }),
    secret: process.env.SESSION_SECRET || 'room-booking-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
  }));

  app.use('/', require('./routes/auth'));
  app.use('/admin', require('./routes/admin'));
  app.use('/partner', require('./routes/partner'));
  app.use('/api', require('./routes/api'));

  app.get('/', (req, res) => {
    if (req.session && req.session.user) {
      return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/partner');
    }
    res.redirect('/login');
  });

  app.listen(PORT, () => console.log(`起動: http://localhost:${PORT}`));
}

start().catch(console.error);
