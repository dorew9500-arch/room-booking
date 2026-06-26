const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'booking.db');
let _db = null;

async function initDB() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
  } else {
    _db = new SQL.Database();
  }

  _db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login_id TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      cleaning_minutes INTEGER DEFAULT 5,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS reception_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL,
      login_id TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS area_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS store_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS partners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      login_id TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      store_id INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS duration_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      minutes INTEGER NOT NULL,
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      partner_id INTEGER,
      client_name TEXT,
      start_at TEXT NOT NULL,
      course_minutes INTEGER NOT NULL,
      block_minutes INTEGER NOT NULL,
      extended INTEGER DEFAULT 0,
      shifted INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // 管理者初期データ
  const adminRes = _db.exec("SELECT id FROM admins WHERE login_id='admin'");
  if (!adminRes.length || !adminRes[0].values.length) {
    const hash = bcrypt.hashSync('admin1234', 10);
    _db.run("INSERT INTO admins (login_id, password_hash) VALUES (?, ?)", ['admin', hash]);
    console.log('管理者アカウント作成: admin / admin1234');
  }

  // 店舗初期データ
  const storeRes = _db.exec("SELECT id FROM stores LIMIT 1");
  if (!storeRes.length || !storeRes[0].values.length) {
    _db.run("INSERT INTO stores (name, cleaning_minutes, sort_order) VALUES (?,?,?)", ['フィジー', 5, 1]);
    _db.run("INSERT INTO stores (name, cleaning_minutes, sort_order) VALUES (?,?,?)", ['ピンクフラミンゴ', 5, 2]);
    console.log('店舗初期データ投入完了');
  }

  // 受付アカウント初期データ
  const recRes = _db.exec("SELECT id FROM reception_accounts LIMIT 1");
  if (!recRes.length || !recRes[0].values.length) {
    _db.run("INSERT INTO reception_accounts (store_id, login_id, password_hash) VALUES (?,?,?)", [1, 'fiji', bcrypt.hashSync('fiji2015', 10)]);
    _db.run("INSERT INTO reception_accounts (store_id, login_id, password_hash) VALUES (?,?,?)", [2, 'pinkfuraminngo', bcrypt.hashSync('pinkfuraminngo2017', 10)]);
    console.log('受付アカウント初期データ投入完了');
  }

  // エリアタグ初期データ（新宿をフィジー・フラミンゴに付与）
  const tagRes = _db.exec("SELECT id FROM area_tags LIMIT 1");
  if (!tagRes.length || !tagRes[0].values.length) {
    _db.run("INSERT INTO area_tags (name, sort_order) VALUES (?,?)", ['新宿', 1]);
    _db.run("INSERT INTO store_tags (store_id, tag_id) VALUES (?,?)", [1, 1]);
    _db.run("INSERT INTO store_tags (store_id, tag_id) VALUES (?,?)", [2, 1]);
    console.log('エリアタグ初期データ投入完了（新宿）');
  }

  // コース時間初期データ（20/30/45/60/75/90/120）
  const durRes = _db.exec("SELECT id FROM duration_options LIMIT 1");
  if (!durRes.length || !durRes[0].values.length) {
    [20, 30, 45, 60, 75, 90, 120].forEach((m, i) => {
      _db.run("INSERT INTO duration_options (minutes, sort_order) VALUES (?,?)", [m, i + 1]);
    });
    console.log('コース時間初期データ投入完了');
  }

  // 部屋初期データ（フィジーに3部屋）
  const roomRes = _db.exec("SELECT id FROM rooms LIMIT 1");
  if (!roomRes.length || !roomRes[0].values.length) {
    _db.run("INSERT INTO rooms (store_id, name, sort_order) VALUES (?,?,?)", [1, '601', 1]);
    _db.run("INSERT INTO rooms (store_id, name, sort_order) VALUES (?,?,?)", [1, '602', 2]);
    _db.run("INSERT INTO rooms (store_id, name, sort_order) VALUES (?,?,?)", [1, '603', 3]);
    console.log('部屋初期データ投入完了');
  }

  saveDB();
  console.log('DB初期化完了');
}

function saveDB() {
  if (_db) {
    const data = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }
}

function getDB() { return _db; }

function query(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = query(sql, params);
  return rows[0] || null;
}

function run(sql, params = []) {
  _db.run(sql, params);
  const lastId = _db.exec("SELECT last_insert_rowid() as id")[0];
  const changes = _db.exec("SELECT changes() as n")[0];
  saveDB();
  return {
    lastInsertRowid: lastId ? lastId.values[0][0] : null,
    changes: changes ? changes.values[0][0] : 0
  };
}

module.exports = { initDB, getDB, query, queryOne, run, saveDB };
