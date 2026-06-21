// server.js - Main application server
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Profile picture upload setup ----------
// Uploaded files are written to UPLOAD_DIR (overridable via env var, same
// pattern as DB_PATH, so a Railway volume can keep them across redeploys).
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Serve uploaded files even if UPLOAD_DIR is outside public/ (e.g. a Railway volume)
app.use('/uploads', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `user${req.session.userId}_${Date.now()}${ext}`);
  }
});

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      return cb(new Error('Only JPG, PNG, GIF or WEBP images are allowed.'));
    }
    cb(null, true);
  }
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
  }
}));

// ---------- Middleware ----------
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'You must be logged in.' });
  }
  next();
}

function publicUser(row) {
  if (!row) return null;
  const { password_hash, email, ...safe } = row;
  return safe;
}

// ---------- Auth routes ----------

// Sign up
app.post('/api/signup', (req, res) => {
  const { username, email, password, display_name } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!/^[a-zA-Z0-9_.]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, _ or . only.' });
  }

  const existing = db.get('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
  if (existing) {
    return res.status(409).json({ error: 'Username or email already taken.' });
  }

  const password_hash = bcrypt.hashSync(password, 10);

  const result = db.run(
    `INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)`,
    [username, email, password_hash, display_name || username]
  );

  req.session.userId = result.lastInsertRowid;
  const user = db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  res.status(201).json({ user: publicUser(user) });
});

// Log in
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }

  const user = db.get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

// Log out
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// Who am I
app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  res.json({ user: publicUser(user) });
});

// ---------- Profile routes ----------

// Get a profile by username
app.get('/api/profile/:username', (req, res) => {
  const profileUser = db.get('SELECT * FROM users WHERE username = ?', [req.params.username]);
  if (!profileUser) return res.status(404).json({ error: 'User not found.' });

  // Log a profile view (only if logged in and not viewing own profile)
  if (req.session.userId && req.session.userId !== profileUser.id) {
    db.run('INSERT INTO profile_views (viewer_id, viewed_id) VALUES (?, ?)', [req.session.userId, profileUser.id]);
  }

  const friendCount = db.get(
    `SELECT COUNT(*) as count FROM friendships WHERE (user_id = ? OR friend_id = ?) AND status = 'accepted'`,
    [profileUser.id, profileUser.id]
  ).count;

  const viewCount = db.get('SELECT COUNT(*) as count FROM profile_views WHERE viewed_id = ?', [profileUser.id]).count;

  const top8 = db.all(
    `SELECT u.id, u.username, u.display_name, u.profile_pic_url
     FROM friendships f
     JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = ? AND f.status = 'accepted' AND f.top8_rank IS NOT NULL
     ORDER BY f.top8_rank ASC LIMIT 8`,
    [profileUser.id]
  );

  res.json({
    user: publicUser(profileUser),
    stats: { friends: friendCount, views: viewCount },
    top8
  });
});

// Update own profile
app.put('/api/profile', requireLogin, (req, res) => {
  const { display_name, bio, location, mood, relationship_status } = req.body;
  db.run(
    `UPDATE users SET display_name = ?, bio = ?, location = ?, mood = ?, relationship_status = ? WHERE id = ?`,
    [display_name, bio, location, mood, relationship_status, req.session.userId]
  );
  const user = db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
  res.json({ user: publicUser(user) });
});

// Upload a new profile picture
app.post('/api/profile/picture', requireLogin, (req, res) => {
  upload.single('picture')(req, res, (err) => {
    if (err) {
      // Multer errors (file too big, wrong type, etc.) land here
      return res.status(400).json({ error: err.message || 'Upload failed.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file was uploaded.' });
    }

    // Delete the old uploaded picture, if there was one, to avoid piling up files
    const existing = db.get('SELECT profile_pic_url FROM users WHERE id = ?', [req.session.userId]);
    if (existing && existing.profile_pic_url && existing.profile_pic_url.startsWith('/uploads/')) {
      const oldPath = path.join(UPLOAD_DIR, path.basename(existing.profile_pic_url));
      fs.unlink(oldPath, () => {}); // best-effort, ignore errors
    }

    const newUrl = `/uploads/${req.file.filename}`;
    db.run('UPDATE users SET profile_pic_url = ? WHERE id = ?', [newUrl, req.session.userId]);
    const user = db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
    res.json({ user: publicUser(user) });
  });
});

// ---------- Wall posts ----------

// Get wall posts for a profile
app.get('/api/profile/:username/wall', (req, res) => {
  const profileUser = db.get('SELECT id FROM users WHERE username = ?', [req.params.username]);
  if (!profileUser) return res.status(404).json({ error: 'User not found.' });

  const posts = db.all(
    `SELECT p.id, p.content, p.created_at, u.username AS author_username, u.display_name AS author_display_name, u.profile_pic_url AS author_pic
     FROM posts p JOIN users u ON u.id = p.author_id
     WHERE p.profile_user_id = ?
     ORDER BY p.created_at DESC LIMIT 50`,
    [profileUser.id]
  );
  res.json({ posts });
});

// Write on someone's wall
app.post('/api/profile/:username/wall', requireLogin, (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Post cannot be empty.' });
  if (content.length > 1000) return res.status(400).json({ error: 'Post is too long.' });

  const profileUser = db.get('SELECT id FROM users WHERE username = ?', [req.params.username]);
  if (!profileUser) return res.status(404).json({ error: 'User not found.' });

  const result = db.run(
    `INSERT INTO posts (profile_user_id, author_id, content) VALUES (?, ?, ?)`,
    [profileUser.id, req.session.userId, content.trim()]
  );
  const post = db.get(
    `SELECT p.id, p.content, p.created_at, u.username AS author_username, u.display_name AS author_display_name, u.profile_pic_url AS author_pic
     FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?`,
    [result.lastInsertRowid]
  );
  res.status(201).json({ post });
});

// Delete a wall post (only the profile owner or the author can delete)
app.delete('/api/posts/:id', requireLogin, (req, res) => {
  const post = db.get('SELECT * FROM posts WHERE id = ?', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  if (post.author_id !== req.session.userId && post.profile_user_id !== req.session.userId) {
    return res.status(403).json({ error: 'You cannot delete this post.' });
  }
  db.run('DELETE FROM posts WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ---------- Home feed ----------

// Recent activity across the whole site (most recent wall posts, newest first).
// Works for logged-out visitors too, since it's public content.
app.get('/api/feed', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  const posts = db.all(
    `SELECT p.id, p.content, p.created_at,
            author.username AS author_username, author.display_name AS author_display_name, author.profile_pic_url AS author_pic,
            profileowner.username AS profile_username, profileowner.display_name AS profile_display_name
     FROM posts p
     JOIN users author ON author.id = p.author_id
     JOIN users profileowner ON profileowner.id = p.profile_user_id
     ORDER BY p.created_at DESC
     LIMIT ?`,
    [limit]
  );
  res.json({ posts });
});

// ---------- Friendships ----------

// Send a friend request
app.post('/api/friends/:username/request', requireLogin, (req, res) => {
  const target = db.get('SELECT id FROM users WHERE username = ?', [req.params.username]);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.session.userId) return res.status(400).json({ error: "You can't friend yourself." });

  try {
    db.run(`INSERT INTO friendships (user_id, friend_id, status) VALUES (?, ?, 'pending')`,
      [req.session.userId, target.id]);
  } catch (e) {
    return res.status(409).json({ error: 'Friend request already exists.' });
  }
  res.status(201).json({ ok: true });
});

// Accept a friend request
app.post('/api/friends/:username/accept', requireLogin, (req, res) => {
  const requester = db.get('SELECT id FROM users WHERE username = ?', [req.params.username]);
  if (!requester) return res.status(404).json({ error: 'User not found.' });

  const result = db.run(
    `UPDATE friendships SET status = 'accepted' WHERE user_id = ? AND friend_id = ? AND status = 'pending'`,
    [requester.id, req.session.userId]
  );
  if (result.changes === 0) return res.status(404).json({ error: 'No pending request found.' });

  // create the reciprocal row so the friendship shows both ways
  try {
    db.run(`INSERT INTO friendships (user_id, friend_id, status) VALUES (?, ?, 'accepted')`,
      [req.session.userId, requester.id]);
  } catch (e) { /* already exists, fine */ }

  res.json({ ok: true });
});

// List my pending friend requests
app.get('/api/friends/requests', requireLogin, (req, res) => {
  const requests = db.all(
    `SELECT u.username, u.display_name, u.profile_pic_url
     FROM friendships f JOIN users u ON u.id = f.user_id
     WHERE f.friend_id = ? AND f.status = 'pending'`,
    [req.session.userId]
  );
  res.json({ requests });
});

// Set Top 8 order
app.post('/api/friends/top8', requireLogin, (req, res) => {
  const { usernames } = req.body; // ordered array, max 8
  if (!Array.isArray(usernames) || usernames.length > 8) {
    return res.status(400).json({ error: 'Provide an array of up to 8 usernames.' });
  }

  // clear existing ranks
  db.run(`UPDATE friendships SET top8_rank = NULL WHERE user_id = ?`, [req.session.userId]);

  usernames.forEach((uname, idx) => {
    const friend = db.get('SELECT id FROM users WHERE username = ?', [uname]);
    if (friend) {
      db.run(
        `UPDATE friendships SET top8_rank = ? WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
        [idx + 1, req.session.userId, friend.id]
      );
    }
  });
  res.json({ ok: true });
});

// ---------- Comments ----------

app.get('/api/posts/:id/comments', (req, res) => {
  const comments = db.all(
    `SELECT c.id, c.content, c.created_at, u.username AS author_username, u.display_name AS author_display_name, u.profile_pic_url AS author_pic
     FROM comments c JOIN users u ON u.id = c.author_id
     WHERE c.post_id = ? ORDER BY c.created_at ASC`,
    [req.params.id]
  );
  res.json({ comments });
});

app.post('/api/posts/:id/comments', requireLogin, (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Comment cannot be empty.' });

  const post = db.get('SELECT id FROM posts WHERE id = ?', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Post not found.' });

  const result = db.run(
    `INSERT INTO comments (post_id, author_id, content) VALUES (?, ?, ?)`,
    [req.params.id, req.session.userId, content.trim()]
  );
  const comment = db.get(
    `SELECT c.id, c.content, c.created_at, u.username AS author_username, u.display_name AS author_display_name, u.profile_pic_url AS author_pic
     FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?`,
    [result.lastInsertRowid]
  );
  res.status(201).json({ comment });
});

// Fallback to index.html for any non-API route (simple SPA-ish behavior)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`10Chat running at http://localhost:${PORT}`);
});
