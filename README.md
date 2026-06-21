# 10Chat — Full Stack Version

A real, working version of the 10Chat social network mockup. Signup, login,
profiles, wall posts, and friend requests are all backed by a real database.

## Stack

- **Backend:** Node.js + Express
- **Database:** SQLite (file-based, zero setup — `node-sqlite3-wasm`, no native compile needed)
- **Auth:** Sessions via `express-session`, passwords hashed with `bcryptjs`
- **Frontend:** Plain HTML/CSS/JS (no build step) — talks to the backend via `fetch()`

## Project structure

```
10chat-app/
├── server.js          # Express app + all API routes
├── db.js               # Database connection + schema (creates tables on first run)
├── package.json
├── public/
│   ├── index.html      # The entire frontend (single page app, no framework)
│   └── images/         # Static assets (put a default-avatar.png here if you want one)
└── 10chat.sqlite        # Created automatically the first time you run the server
```

## How to run it

1. Install dependencies (only needed once):
   ```
   npm install
   ```

2. Start the server:
   ```
   npm start
   ```

3. Open your browser to **http://localhost:3000**

That's it — no separate database server, no build step. The SQLite file
(`10chat.sqlite`) is created automatically the first time you start the server.

To start fresh, just delete `10chat.sqlite` and restart the server.

## What's actually working right now

- **Sign up / log in / log out** — real password hashing (bcrypt), real sessions (cookies)
- **Profiles** — bio, location, mood, relationship status, all editable when you're
  viewing your own profile
- **Profile picture uploads** — JPG/PNG/GIF/WEBP, 5MB max, old picture is deleted
  automatically when you upload a new one
- **Home feed** — recent wall posts from across the whole site, newest first
- **User search** — search bar in the sidebar, finds users by username or display
  name, links straight to their profile
- **Friend requests, full flow** — send, accept, decline, cancel a sent request,
  or remove an existing friend. The profile page shows the right button for
  whatever the current relationship actually is (none / pending / friends)
- **Wall posts, likes, threaded comments** — post on your own or someone else's
  wall, like/unlike, comment, reply to a specific comment one level deep,
  delete your own posts/comments
- **Favourites (Top 8)** — a dedicated page to pick up to 8 friends to feature
  on your profile, with a one-click toggle per friend
- **Direct messages** — real one-on-one conversations, a conversation list with
  unread counts, messages marked as read when you open a thread
- **Groups** — create a group, join/leave, each group has its own wall that
  members can post to, only the creator can delete the group
- **Online/offline presence** — anyone active in the last 5 minutes shows as
  "online" (a green dot) wherever they appear: friends list, profile, message
  threads. This re-checks every 30 seconds while you have the app open, and
  updates instantly whenever you make any request yourself
- **Profile view tracking** — every time you visit someone's profile while logged
  in, it logs a view and the view count goes up

## Design

The UI is a full-width three-column layout (dark sidebar, light center feed,
dark right rail) rather than the boxed 800x600 retro look from earlier
versions. Color palette: `#f5ede9` (light background), `#0d0907` (dark
surfaces/cards), `#ffffff` (text on dark). It collapses to two columns on
medium screens and a single column on narrow/mobile screens.

## What's next (left for you to build, or ask me to add)

1. **A "friends only" feed option** — right now the home feed shows posts from
   everyone site-wide; filtering to just your friends is a natural next step
2. **Real-time push updates** — presence and unread counts currently refresh
   on a 30-second poll, not instantly. True real-time would need WebSockets
   (Socket.io) — doable, but a bigger change
3. **Notifications** — no notification center yet for new friend requests,
   likes, or comments; you'd only see them by checking the relevant page
4. **Deploying it somewhere public** — already covered if you followed the
   GitHub/Railway steps. Worth knowing: if you set `UPLOAD_DIR` to a path on
   your Railway volume (the same one used for `DB_PATH`), uploaded profile
   pictures will survive redeploys too — otherwise they'll be wiped just like
   the SQLite file would be without a volume

## Admin access

There's a simple admin dashboard at `/admin` that shows aggregate stats and a
user list — **no emails, no password hashes, no personal details**, just
usernames, display names, join dates, and online status. It exists so you can
check the site is actually being used without exposing anyone's private data.

There's deliberately no signup flow or API route that grants admin — it can
only be set by running a script directly where the server runs, so a regular
user could never grant it to themselves.

**To make yourself an admin, locally:**
```
node make-admin.js your_username
```

**On Railway:** open a shell for your service (Railway's dashboard has a
"shell" / "run command" option under your service, or use the Railway CLI
with `railway run`), then run the same command in the project directory:
```
railway run node make-admin.js your_username
```

To revoke admin from someone: `node make-admin.js their_username revoke`

What's on the dashboard:
- Total users, how many are online right now, signups today / this week
- Total posts, groups, and messages site-wide (counts only, not content)
- A list of every user: username, display name, join date, online dot, and
  whether they're an admin



- **Passwords are never stored in plain text.** `bcryptjs` hashes them before
  they touch the database, and the hash is never sent back to the frontend.
- **Sessions, not tokens.** The `connect.sid` cookie is what keeps you logged
  in. It's `httpOnly`, so frontend JavaScript can't read it (helps prevent
  some types of attacks).
- **The `SESSION_SECRET` in `server.js` is a placeholder.** If you ever deploy
  this somewhere real, set an actual secret via an environment variable rather
  than the hardcoded default.
- **No rate limiting yet.** Right now someone could hammer `/api/login` with
  guesses. Worth adding something like `express-rate-limit` before this is
  genuinely public.
- **If `npm start` ever fails with "database is locked"**, it usually means a
  previous server process didn't shut down cleanly and left a
  `10chat.sqlite.lock` folder behind. Stop any running `node server.js`
  process and delete that lock folder, then start again.
