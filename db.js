// db.js - Database setup and schema
const { Database } = require('node-sqlite3-wasm');
const path = require('path');

// Use DB_PATH env var if set (e.g. a Railway volume mount like /data/10chat.sqlite),
// otherwise default to a local file next to this script for local development.
const dbPath = process.env.DB_PATH || path.join(__dirname, '10chat.sqlite');
const db = new Database(dbPath);

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    bio TEXT DEFAULT '',
    location TEXT DEFAULT '',
    mood TEXT DEFAULT '',
    relationship_status TEXT DEFAULT '',
    profile_pic_url TEXT DEFAULT '/images/default-avatar.png',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_user_id INTEGER NOT NULL,   -- whose wall this is posted on
    author_id INTEGER NOT NULL,         -- who wrote it
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_user_id) REFERENCES users(id),
    FOREIGN KEY (author_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    author_id INTEGER NOT NULL,
    parent_comment_id INTEGER DEFAULT NULL,  -- NULL = top-level comment, otherwise a reply
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES posts(id),
    FOREIGN KEY (author_id) REFERENCES users(id),
    FOREIGN KEY (parent_comment_id) REFERENCES comments(id)
  );

  CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES posts(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(post_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS friendships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',  -- 'pending' or 'accepted'
    top8_rank INTEGER DEFAULT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (friend_id) REFERENCES users(id),
    UNIQUE(user_id, friend_id)
  );

  CREATE TABLE IF NOT EXISTS profile_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    viewer_id INTEGER NOT NULL,
    viewed_id INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (viewer_id) REFERENCES users(id),
    FOREIGN KEY (viewed_id) REFERENCES users(id)
  );
`);

// ---------- Migrations for databases created before this column existed ----------
// (Safe to run every time: checks the column first, only adds it if missing.)
const commentCols = db.all(`PRAGMA table_info(comments)`).map(c => c.name);
if (!commentCols.includes('parent_comment_id')) {
  db.exec(`ALTER TABLE comments ADD COLUMN parent_comment_id INTEGER DEFAULT NULL`);
}

module.exports = db;
