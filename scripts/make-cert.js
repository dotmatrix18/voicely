// Generates a self-signed certificate in ./certs so phones on your Wi-Fi can use the mic over HTTPS.
const fs = require('fs');
const os = require('os');
const path = require('path');
const selfsigned = require('selfsigned');

const ips = [];
for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4') ips.push(n.address);
const altNames = [{ type: 2, value: 'localhost' }, ...ips.map((ip) => ({ type: 7, ip }))];
const pems = selfsigned.generate([{ name: 'commonName', value: 'voice-only-chat.local' }], {
  days: 365, keySize: 2048, algorithm: 'sha256',
  extensions: [{ name: 'subjectAltName', altNames }],
});
const dir = path.join(__dirname, '..', 'certs');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'key.pem'), pems.private);
fs.writeFileSync(path.join(dir, 'cert.pem'), pems.cert);
console.log('Self-signed certificate written to ./certs for:', ['localhost', ...ips].join(', '));
