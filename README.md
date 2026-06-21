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
- **Wall posts** — post on your own or someone else's wall, delete posts you wrote
  or posts on your own wall
- **Friend requests** — send a request, accept it, see friend counts
- **Top 8** — backend route exists (`POST /api/friends/top8`) but there's no UI for
  reordering yet — see "What's next" below
- **Profile view tracking** — every time you visit someone's profile while logged
  in, it logs a view and the view count goes up

## What's next (left for you to build, or ask me to add)

These are the natural next steps, roughly in order of how much it'll feel like
"the real thing":

1. **Profile picture uploads** — `multer` is already installed for this, just
   needs a route + a file input in the UI
2. **A UI for the Top 8 friends reordering** (drag and drop, or simple dropdowns)
3. **Friend request UI** — right now you can send a request via the API but
   there's no inbox screen to see/accept incoming requests
4. **Comments on individual posts** — the comments table and API routes exist,
   just needs wiring into the frontend
5. **Real-time stuff** — notifications when someone friends you or comments,
   would need WebSockets (Socket.io) eventually
6. **Deploying it somewhere public** — right now this only runs on your machine.
   Render, Railway, or Fly.io can all host this almost as-is; SQLite works fine
   for a small personal project but you'd eventually want Postgres if more than
   a few people use it at once

## A few things worth knowing as you keep building

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
