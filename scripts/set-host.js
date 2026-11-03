'use strict';

// npm run set-host               writes this computer's current network address into public/config.js
// npm run set-host -- 25.1.2.3   writes that address instead (a VPN address, for example)
// start.command runs it with --start every time, so the address always matches the current network.

const fs = require('fs');
const os = require('os');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'config.js');
const lan = Object.values(os.networkInterfaces())
  .flat()
  .filter((net) => net && net.family === 'IPv4' && !net.internal)
  .map((net) => net.address);

const args = process.argv.slice(2);
const fromStart = args.includes('--start');
const host = args.find((arg) => arg !== '--start') || lan[0];
if (!host) {
  console.error('No network address found. Join the Wi-Fi or hotspot first.');
  process.exit(1);
}

const before = fs.readFileSync(file, 'utf8');
const after = before.replace(/SERVER_HOST: '[^']*'/, `SERVER_HOST: '${host}'`);
if (after !== before) fs.writeFileSync(file, after);
console.log(`SERVER_HOST is now ${host}`);
if (lan.length > 1) console.log(`This computer also has: ${lan.filter((address) => address !== host).join(', ')}`);
if (!fromStart) console.log('Restart the server, and copy public/ to the second computer again.');
