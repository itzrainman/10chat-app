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

function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'You must be logged in.' });
  }
  const user = db.get('SELECT is_admin FROM users WHERE id = ?', [req.session.userId]);
  if (!user || !user.is_admin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// Lightweight presence tracking: every request from a logged-in user bumps
// their last_active timestamp. "Online" is then just "active in the last N minutes".
const PRESENCE_WINDOW_MINUTES = 5;
app.use((req, res, next) => {
  if (req.session.userId) {
    db.run(`UPDATE users SET last_active = CURRENT_TIMESTAMP WHERE id = ?`, [req.session.userId]);
  }
  next();
});

function publicUser(row) {
  if (!row) return null;
  const { password_hash, email, ...safe } = row;
  return safe;
}

// A user counts as "online" if they've made a request in the last few minutes
function isOnline(lastActiveStr) {
  if (!lastActiveStr) return false;
  const lastActive = new Date(lastActiveStr + 'Z').getTime();
  return (Date.now() - lastActive) < PRESENCE_WINDOW_MINUTES * 60 * 1000;
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
    user: { ...publicUser(profileUser), is_online: isOnline(profileUser.last_active) },
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

// Attach like count, whether the current viewer liked it, and comment count to a list of posts
function enrichPostsWithLikesAndComments(posts, viewerId) {
  return posts.map(p => {
    const likeCount = db.get('SELECT COUNT(*) AS count FROM likes WHERE post_id = ?', [p.id]).count;
    const liked = viewerId
      ? !!db.get('SELECT id FROM likes WHERE post_id = ? AND user_id = ?', [p.id, viewerId])
      : false;
    const commentCount = db.get('SELECT COUNT(*) AS count FROM comments WHERE post_id = ?', [p.id]).count;
    return { ...p, like_count: likeCount, liked_by_me: liked, comment_count: commentCount };
  });
}

// Get wall posts for a profile
app.get('/api/profile/:username/wall', (req, res) => {
  const profileUser = db.get('SELECT id FROM users WHERE username = ?', [req.params.username]);
  if (!profileUser) return res.status(404).json({ error: 'User not found.' });

  let posts = db.all(
    `SELECT p.id, p.content, p.created_at, u.username AS author_username, u.display_name AS author_display_name, u.profile_pic_url AS author_pic
     FROM posts p JOIN users u ON u.id = p.author_id
     WHERE p.profile_user_id = ?
     ORDER BY p.created_at DESC LIMIT 50`,
    [profileUser.id]
  );
  posts = enrichPostsWithLikesAndComments(posts, req.session.userId);
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
  let posts = db.all(
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
  posts = enrichPostsWithLikesAndComments(posts, req.session.userId);
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

// List my accepted friends, with online status, online-first
app.get('/api/friends', requireLogin, (req, res) => {
  const friends = db.all(
    `SELECT u.username, u.display_name, u.profile_pic_url, u.last_active
     FROM friendships f JOIN users u ON u.id = f.friend_id
     WHERE f.user_id = ? AND f.status = 'accepted'`,
    [req.session.userId]
  ).map(f => ({ ...f, is_online: isOnline(f.last_active) }));

  friends.sort((a, b) => {
    if (a.is_online !== b.is_online) return a.is_online ? -1 : 1;
    return new Date(b.last_active || 0) - new Date(a.last_active || 0);
  });

  res.json({ friends });
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

// Reject/cancel a friend request (works whether you're the recipient declining,
// or the sender cancelling their own pending request)
app.post('/api/friends/:username/reject', requireLogin, (req, res) => {
  const other = db.get('SELECT id FROM users WHERE username = ?', [req.params.username]);
  if (!other) return res.status(404).json({ error: 'User not found.' });

  const result = db.run(
    `DELETE FROM friendships WHERE status = 'pending' AND
     ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?))`,
    [other.id, req.session.userId, req.session.userId, other.id]
  );
  if (result.changes === 0) return res.status(404).json({ error: 'No pending request found.' });
  res.json({ ok: true });
});

// Unfriend someone (removes both directions of an accepted friendship)
app.post('/api/friends/:username/remove', requireLogin, (req, res) => {
  const other = db.get('SELECT id FROM users WHERE username = ?', [req.params.username]);
  if (!other) return res.status(404).json({ error: 'User not found.' });

  db.run(
    `DELETE FROM friendships WHERE
     (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
    [req.session.userId, other.id, other.id, req.session.userId]
  );
  res.json({ ok: true });
});

// Check the friendship status between the logged-in user and another user.
// Returns one of: 'self', 'none', 'pending_sent', 'pending_received', 'friends'
app.get('/api/friends/:username/status', requireLogin, (req, res) => {
  const other = db.get('SELECT id FROM users WHERE username = ?', [req.params.username]);
  if (!other) return res.status(404).json({ error: 'User not found.' });

  if (other.id === req.session.userId) return res.json({ status: 'self' });

  const sent = db.get(`SELECT status FROM friendships WHERE user_id = ? AND friend_id = ?`,
    [req.session.userId, other.id]);
  const received = db.get(`SELECT status FROM friendships WHERE user_id = ? AND friend_id = ?`,
    [other.id, req.session.userId]);

  if (sent?.status === 'accepted' || received?.status === 'accepted') {
    return res.json({ status: 'friends' });
  }
  if (sent?.status === 'pending') return res.json({ status: 'pending_sent' });
  if (received?.status === 'pending') return res.json({ status: 'pending_received' });
  res.json({ status: 'none' });
});

// ---------- User search ----------

// Search for users by username (partial match, case-insensitive)
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ users: [] });
  if (q.length > 50) return res.status(400).json({ error: 'Search term too long.' });

  const users = db.all(
    `SELECT username, display_name, profile_pic_url
     FROM users
     WHERE username LIKE ? OR display_name LIKE ?
     ORDER BY username ASC
     LIMIT 20`,
    [`%${q}%`, `%${q}%`]
  );
  res.json({ users });
});

// ---------- Comments (threaded) ----------

// Get all comments for a post, organized as a tree (top-level comments with nested replies)
app.get('/api/posts/:id/comments', (req, res) => {
  const flat = db.all(
    `SELECT c.id, c.content, c.created_at, c.parent_comment_id,
            u.username AS author_username, u.display_name AS author_display_name, u.profile_pic_url AS author_pic
     FROM comments c JOIN users u ON u.id = c.author_id
     WHERE c.post_id = ? ORDER BY c.created_at ASC`,
    [req.params.id]
  );

  // Build a tree: top-level comments hold a `replies` array of their children
  const byId = {};
  flat.forEach(c => { byId[c.id] = { ...c, replies: [] }; });
  const topLevel = [];
  flat.forEach(c => {
    if (c.parent_comment_id && byId[c.parent_comment_id]) {
      byId[c.parent_comment_id].replies.push(byId[c.id]);
    } else {
      topLevel.push(byId[c.id]);
    }
  });

  res.json({ comments: topLevel });
});

// Add a comment, or a reply to an existing comment (pass parent_comment_id to reply)
app.post('/api/posts/:id/comments', requireLogin, (req, res) => {
  const { content, parent_comment_id } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Comment cannot be empty.' });
  if (content.length > 500) return res.status(400).json({ error: 'Comment is too long.' });

  const post = db.get('SELECT id FROM posts WHERE id = ?', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Post not found.' });

  let parentId = null;
  if (parent_comment_id) {
    const parent = db.get('SELECT id, post_id FROM comments WHERE id = ?', [parent_comment_id]);
    if (!parent || parent.post_id !== post.id) {
      return res.status(400).json({ error: 'Invalid comment to reply to.' });
    }
    parentId = parent.id;
  }

  const result = db.run(
    `INSERT INTO comments (post_id, author_id, parent_comment_id, content) VALUES (?, ?, ?, ?)`,
    [req.params.id, req.session.userId, parentId, content.trim()]
  );
  const comment = db.get(
    `SELECT c.id, c.content, c.created_at, c.parent_comment_id, u.username AS author_username, u.display_name AS author_display_name, u.profile_pic_url AS author_pic
     FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?`,
    [result.lastInsertRowid]
  );
  res.status(201).json({ comment: { ...comment, replies: [] } });
});

// Delete a comment (only the comment author can delete; also deletes its replies)
app.delete('/api/comments/:id', requireLogin, (req, res) => {
  const comment = db.get('SELECT * FROM comments WHERE id = ?', [req.params.id]);
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });
  if (comment.author_id !== req.session.userId) {
    return res.status(403).json({ error: 'You cannot delete this comment.' });
  }
  db.run('DELETE FROM comments WHERE id = ? OR parent_comment_id = ?', [req.params.id, req.params.id]);
  res.json({ ok: true });
});

// ---------- Likes ----------

// Toggle a like on a post (like if not liked, unlike if already liked)
app.post('/api/posts/:id/like', requireLogin, (req, res) => {
  const post = db.get('SELECT id FROM posts WHERE id = ?', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Post not found.' });

  const existing = db.get('SELECT id FROM likes WHERE post_id = ? AND user_id = ?',
    [req.params.id, req.session.userId]);

  if (existing) {
    db.run('DELETE FROM likes WHERE id = ?', [existing.id]);
  } else {
    db.run('INSERT INTO likes (post_id, user_id) VALUES (?, ?)', [req.params.id, req.session.userId]);
  }

  const count = db.get('SELECT COUNT(*) AS count FROM likes WHERE post_id = ?', [req.params.id]).count;
  res.json({ liked: !existing, count });
});

// Get like info for a post (count + whether the current user has liked it)
app.get('/api/posts/:id/likes', (req, res) => {
  const count = db.get('SELECT COUNT(*) AS count FROM likes WHERE post_id = ?', [req.params.id]).count;
  let liked = false;
  if (req.session.userId) {
    liked = !!db.get('SELECT id FROM likes WHERE post_id = ? AND user_id = ?', [req.params.id, req.session.userId]);
  }
  res.json({ count, liked });
});

// ---------- Direct Messages ----------

// List my conversations (one row per other user I've exchanged messages with,
// showing the most recent message and unread count)
app.get('/api/messages/conversations', requireLogin, (req, res) => {
  const me = req.session.userId;
  const partners = db.all(
    `SELECT DISTINCT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS other_id
     FROM messages WHERE sender_id = ? OR recipient_id = ?`,
    [me, me, me]
  );

  const conversations = partners.map(({ other_id }) => {
    const other = db.get('SELECT username, display_name, profile_pic_url, last_active FROM users WHERE id = ?', [other_id]);
    const lastMsg = db.get(
      `SELECT content, created_at, sender_id FROM messages
       WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
       ORDER BY created_at DESC LIMIT 1`,
      [me, other_id, other_id, me]
    );
    const unreadCount = db.get(
      `SELECT COUNT(*) AS count FROM messages WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`,
      [other_id, me]
    ).count;
    return {
      username: other.username,
      display_name: other.display_name,
      profile_pic_url: other.profile_pic_url,
      is_online: isOnline(other.last_active),
      last_message: lastMsg,
      unread_count: unreadCount
    };
  });

  conversations.sort((a, b) => new Date(b.last_message?.created_at || 0) - new Date(a.last_message?.created_at || 0));
  res.json({ conversations });
});

// Get the message thread with a specific user, and mark their messages to me as read
app.get('/api/messages/:username', requireLogin, (req, res) => {
  const other = db.get('SELECT id, username, display_name, profile_pic_url, last_active FROM users WHERE username = ?', [req.params.username]);
  if (!other) return res.status(404).json({ error: 'User not found.' });

  const me = req.session.userId;
  const messages = db.all(
    `SELECT id, sender_id, recipient_id, content, created_at, read_at FROM messages
     WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
     ORDER BY created_at ASC`,
    [me, other.id, other.id, me]
  );

  db.run(
    `UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`,
    [other.id, me]
  );

  res.json({
    other: { username: other.username, display_name: other.display_name, profile_pic_url: other.profile_pic_url, is_online: isOnline(other.last_active) },
    messages
  });
});

// Send a message to a user
app.post('/api/messages/:username', requireLogin, (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (content.length > 2000) return res.status(400).json({ error: 'Message is too long.' });

  const other = db.get('SELECT id FROM users WHERE username = ?', [req.params.username]);
  if (!other) return res.status(404).json({ error: 'User not found.' });
  if (other.id === req.session.userId) return res.status(400).json({ error: "You can't message yourself." });

  const result = db.run(
    `INSERT INTO messages (sender_id, recipient_id, content) VALUES (?, ?, ?)`,
    [req.session.userId, other.id, content.trim()]
  );
  const message = db.get('SELECT id, sender_id, recipient_id, content, created_at, read_at FROM messages WHERE id = ?', [result.lastInsertRowid]);
  res.status(201).json({ message });
});

// Unread message count across all conversations (for a nav badge)
app.get('/api/messages/unread/count', requireLogin, (req, res) => {
  const count = db.get(
    `SELECT COUNT(*) AS count FROM messages WHERE recipient_id = ? AND read_at IS NULL`,
    [req.session.userId]
  ).count;
  res.json({ count });
});

// ---------- Groups ----------

// List all groups (with member count), optionally filtered by search term
app.get('/api/groups', (req, res) => {
  const q = (req.query.q || '').trim();
  const groups = db.all(
    q
      ? `SELECT g.*, (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count
         FROM groups g WHERE g.name LIKE ? ORDER BY g.created_at DESC`
      : `SELECT g.*, (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count
         FROM groups g ORDER BY g.created_at DESC`,
    q ? [`%${q}%`] : []
  );

  if (req.session.userId) {
    const myGroupIds = new Set(
      db.all(`SELECT group_id FROM group_members WHERE user_id = ?`, [req.session.userId]).map(r => r.group_id)
    );
    groups.forEach(g => { g.is_member = myGroupIds.has(g.id); });
  }

  res.json({ groups });
});

// Create a new group (creator is automatically the first member)
app.post('/api/groups', requireLogin, (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Group name is required.' });
  if (name.length > 60) return res.status(400).json({ error: 'Group name is too long.' });

  let result;
  try {
    result = db.run(
      `INSERT INTO groups (name, description, creator_id) VALUES (?, ?, ?)`,
      [name.trim(), (description || '').trim(), req.session.userId]
    );
  } catch (e) {
    return res.status(409).json({ error: 'A group with that name already exists.' });
  }

  db.run(`INSERT INTO group_members (group_id, user_id) VALUES (?, ?)`, [result.lastInsertRowid, req.session.userId]);
  const group = db.get('SELECT * FROM groups WHERE id = ?', [result.lastInsertRowid]);
  res.status(201).json({ group });
});

// Get a single group's details, members, and recent posts
app.get('/api/groups/:id', (req, res) => {
  const group = db.get('SELECT * FROM groups WHERE id = ?', [req.params.id]);
  if (!group) return res.status(404).json({ error: 'Group not found.' });

  const members = db.all(
    `SELECT u.username, u.display_name, u.profile_pic_url
     FROM group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ? ORDER BY gm.joined_at ASC`,
    [req.params.id]
  );

  const isMember = req.session.userId
    ? !!db.get('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?', [req.params.id, req.session.userId])
    : false;

  res.json({ group, members, member_count: members.length, is_member: isMember, is_creator: group.creator_id === req.session.userId });
});

// Join a group
app.post('/api/groups/:id/join', requireLogin, (req, res) => {
  const group = db.get('SELECT id FROM groups WHERE id = ?', [req.params.id]);
  if (!group) return res.status(404).json({ error: 'Group not found.' });

  try {
    db.run(`INSERT INTO group_members (group_id, user_id) VALUES (?, ?)`, [req.params.id, req.session.userId]);
  } catch (e) {
    return res.status(409).json({ error: 'You are already in this group.' });
  }
  res.status(201).json({ ok: true });
});

// Leave a group
app.post('/api/groups/:id/leave', requireLogin, (req, res) => {
  const result = db.run(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`, [req.params.id, req.session.userId]);
  if (result.changes === 0) return res.status(404).json({ error: 'You are not in this group.' });
  res.json({ ok: true });
});

// Delete a group (creator only)
app.delete('/api/groups/:id', requireLogin, (req, res) => {
  const group = db.get('SELECT * FROM groups WHERE id = ?', [req.params.id]);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  if (group.creator_id !== req.session.userId) {
    return res.status(403).json({ error: 'Only the group creator can delete this group.' });
  }
  db.run(`DELETE FROM group_posts WHERE group_id = ?`, [req.params.id]);
  db.run(`DELETE FROM group_members WHERE group_id = ?`, [req.params.id]);
  db.run(`DELETE FROM groups WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

// Get a group's wall posts
app.get('/api/groups/:id/posts', (req, res) => {
  const posts = db.all(
    `SELECT p.id, p.content, p.created_at, u.username AS author_username, u.display_name AS author_display_name, u.profile_pic_url AS author_pic
     FROM group_posts p JOIN users u ON u.id = p.author_id
     WHERE p.group_id = ? ORDER BY p.created_at DESC LIMIT 100`,
    [req.params.id]
  );
  res.json({ posts });
});

// Post to a group's wall (members only)
app.post('/api/groups/:id/posts', requireLogin, (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Post cannot be empty.' });
  if (content.length > 1000) return res.status(400).json({ error: 'Post is too long.' });

  const isMember = !!db.get('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?', [req.params.id, req.session.userId]);
  if (!isMember) return res.status(403).json({ error: 'Only group members can post.' });

  const result = db.run(
    `INSERT INTO group_posts (group_id, author_id, content) VALUES (?, ?, ?)`,
    [req.params.id, req.session.userId, content.trim()]
  );
  const post = db.get(
    `SELECT p.id, p.content, p.created_at, u.username AS author_username, u.display_name AS author_display_name, u.profile_pic_url AS author_pic
     FROM group_posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?`,
    [result.lastInsertRowid]
  );
  res.status(201).json({ post });
});

// ---------- Admin (no personal details exposed: no emails, no password hashes) ----------

// High-level counts: total users, online right now, signups today/this week
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const totalUsers = db.get('SELECT COUNT(*) AS count FROM users').count;
  const totalPosts = db.get('SELECT COUNT(*) AS count FROM posts').count;
  const totalGroups = db.get('SELECT COUNT(*) AS count FROM groups').count;
  const totalMessages = db.get('SELECT COUNT(*) AS count FROM messages').count;

  const allUsers = db.all('SELECT last_active FROM users');
  const onlineNow = allUsers.filter(u => isOnline(u.last_active)).length;

  const signupsToday = db.get(
    `SELECT COUNT(*) AS count FROM users WHERE date(created_at) = date('now')`
  ).count;
  const signupsThisWeek = db.get(
    `SELECT COUNT(*) AS count FROM users WHERE created_at >= datetime('now', '-7 days')`
  ).count;

  res.json({
    total_users: totalUsers,
    online_now: onlineNow,
    signups_today: signupsToday,
    signups_this_week: signupsThisWeek,
    total_posts: totalPosts,
    total_groups: totalGroups,
    total_messages: totalMessages
  });
});

// List of users — username, display name, signup date, online status only.
// Explicitly never includes email, password_hash, bio, or any other personal field.
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.all(
    `SELECT username, display_name, created_at, last_active, is_admin FROM users ORDER BY created_at DESC`
  ).map(u => ({
    username: u.username,
    display_name: u.display_name,
    created_at: u.created_at,
    is_online: isOnline(u.last_active),
    is_admin: !!u.is_admin
  }));
  res.json({ users });
});

// Fallback to index.html for any non-API route (simple SPA-ish behavior)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`10Chat running at http://localhost:${PORT}`);
});
