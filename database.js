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
      name TEXT NOT NULL UNIQUE,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS duration_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      duration INTEGER NOT NULL,
      actual_duration INTEGER,
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      partner_id INTEGER,
      client_name TEXT,
      start_at TEXT NOT NULL,
      duration INTEGER NOT NULL,
      actual_duration INTEGER,
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

  // 利用時間メニュー初期データ
  const durRes = _db.exec("SELECT id FROM duration_options LIMIT 1");
  if (!durRes.length || !durRes[0].values.length) {
    _db.run("INSERT INTO duration_options (label, duration, actual_duration, sort_order) VALUES (?,?,?,?)", ['20分', 20, null, 1]);
    _db.run("INSERT INTO duration_options (label, duration, actual_duration, sort_order) VALUES (?,?,?,?)", ['30分', 30, null, 2]);
    _db.run("INSERT INTO duration_options (label, duration, actual_duration, sort_order) VALUES (?,?,?,?)", ['50分 / 実質45分', 50, 45, 3]);
    _db.run("INSERT INTO duration_options (label, duration, actual_duration, sort_order) VALUES (?,?,?,?)", ['65分 / 実質60分', 65, 60, 4]);
    _db.run("INSERT INTO duration_options (label, duration, actual_duration, sort_order) VALUES (?,?,?,?)", ['90分', 90, null, 5]);
    console.log('利用時間メニュー初期データ投入完了');
  }

  // 部屋初期データ
  const roomRes = _db.exec("SELECT id FROM rooms LIMIT 1");
  if (!roomRes.length || !roomRes[0].values.length) {
    _db.run("INSERT INTO rooms (name, sort_order) VALUES (?,?)", ['601', 1]);
    _db.run("INSERT INTO rooms (name, sort_order) VALUES (?,?)", ['602', 2]);
    _db.run("INSERT INTO rooms (name, sort_order) VALUES (?,?)", ['603', 3]);
    console.log('部屋初期データ投入完了（601・602・603）');
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

function getDB() {
  return _db;
}

// sql.js用ヘルパー（better-sqlite3風のAPI）
function query(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
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
