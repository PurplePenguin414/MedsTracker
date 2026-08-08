// Run this once to generate a password hash for your .env file:
//   node hash-password.js "yourActualPassword"
// Then copy the printed hash into APP_PASSWORD_HASH in your .env file.

const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node hash-password.js "yourPassword"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
console.log('\nAdd this to your .env file:\n');
console.log(`APP_PASSWORD_HASH=${hash}\n`);
