// می‌سازه: یه CA محلی (فقط برای همین شبکه) + یه گواهی سرور که همون CA امضاش کرده، بدون
// نیاز به هیچ سرویس بیرونی/دامنه/اینترنت - کاملاً آفلاین. IPِ سرور رو خودکار از رابط شبکه
// می‌خونه؛ اگه IP سرور عوض بشه، این اسکریپت رو دوباره اجرا کنید (certs/ رو پاک کنید یا
// --force بدید) و گواهی CA رو دوباره روی گوشی‌ها نصب کنید.
//
// استفاده: node generate-https-cert.js [--force]
const fs = require('fs');
const os = require('os');
const path = require('path');
const forge = require('node-forge');

const CERT_DIR = path.join(__dirname, 'certs');
const force = process.argv.includes('--force');

function getLanIPs() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

function randomSerial() {
  return forge.util.bytesToHex(forge.random.getBytesSync(16));
}

function main() {
  if (fs.existsSync(CERT_DIR) && !force) {
    const files = ['ca-cert.pem', 'server-key.pem', 'server-cert.pem'];
    if (files.every(f => fs.existsSync(path.join(CERT_DIR, f)))) {
      console.log('✅ گواهی‌ها از قبل توی certs/ هستن - چیزی ساخته نشد (برای بازسازی: node generate-https-cert.js --force)');
      return;
    }
  }
  fs.mkdirSync(CERT_DIR, { recursive: true });

  const lanIPs = getLanIPs();
  if (lanIPs.length === 0) lanIPs.push('127.0.0.1');
  console.log('🌐 IPهای شبکه‌ی محلیِ پیدا‌شده برای این گواهی:', lanIPs.join(', '));

  // ===== CA =====
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = randomSerial();
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter = new Date();
  caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 10);
  const caAttrs = [{ name: 'commonName', value: 'Warehouse LAN Root CA' }, { name: 'organizationName', value: 'Warehouse LAN (local only)' }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' }
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  // ===== گواهی سرور، امضاشده توسط CA بالا =====
  const serverKeys = forge.pki.rsa.generateKeyPair(2048);
  const serverCert = forge.pki.createCertificate();
  serverCert.publicKey = serverKeys.publicKey;
  serverCert.serialNumber = randomSerial();
  serverCert.validity.notBefore = new Date();
  serverCert.validity.notAfter = new Date();
  serverCert.validity.notAfter.setFullYear(serverCert.validity.notBefore.getFullYear() + 10);
  serverCert.setSubject([{ name: 'commonName', value: lanIPs[0] }]);
  serverCert.setIssuer(caAttrs);

  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }];
  lanIPs.forEach(ip => altNames.push({ type: 7, ip }));

  serverCert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
    { name: 'authorityKeyIdentifier' }
  ]);
  serverCert.sign(caKeys.privateKey, forge.md.sha256.create());

  fs.writeFileSync(path.join(CERT_DIR, 'ca-key.pem'), forge.pki.privateKeyToPem(caKeys.privateKey));
  fs.writeFileSync(path.join(CERT_DIR, 'ca-cert.pem'), forge.pki.certificateToPem(caCert));
  fs.writeFileSync(path.join(CERT_DIR, 'server-key.pem'), forge.pki.privateKeyToPem(serverKeys.privateKey));
  fs.writeFileSync(path.join(CERT_DIR, 'server-cert.pem'), forge.pki.certificateToPem(serverCert));

  console.log('✅ گواهی‌ها ساخته شدن توی certs/');
  console.log('   - ca-cert.pem: باید یه‌بار روی هر گوشی نصب/تایید بشه (از /ca.crt قابل دانلوده)');
  console.log('   - server-key.pem / server-cert.pem: روی خودِ سرور می‌مونن، جایی فرستاده نمی‌شن');
}

main();
