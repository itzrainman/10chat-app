// make-admin.js
// Run this manually to grant (or revoke) admin access for a user.
// There is no API route or UI for this on purpose — it should only be possible
// from direct server access, so a regular user can never grant themselves admin.
//
// Usage:
//   node make-admin.js <username>          -> grants admin
//   node make-admin.js <username> revoke   -> revokes admin
//
// On Railway: open a shell for your service (railway run, or the web shell if
// available) and run this the same way, in the same directory as server.js.

const db = require('./db');

const username = process.argv[2];
const revoke = process.argv[3] === 'revoke';

if (!username) {
  console.log('Usage: node make-admin.js <username> [revoke]');
  process.exit(1);
}

const user = db.get('SELECT id, username, is_admin FROM users WHERE username = ?', [username]);
if (!user) {
  console.log(`No user found with username "${username}".`);
  process.exit(1);
}

db.run('UPDATE users SET is_admin = ? WHERE id = ?', [revoke ? 0 : 1, user.id]);
console.log(`${revoke ? 'Revoked' : 'Granted'} admin for "${username}".`);
