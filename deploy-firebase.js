const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const zlib = require('zlib');

const configPath = path.join(process.env.USERPROFILE, '.config', 'configstore', 'firebase-tools.json');
const configstore = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const token = configstore.tokens.access_token;
const projectId = 'usb-charger-project';
const siteId = 'usb-charger-project';
const publicDir = 'C:/Users/ROOM_A/.gemini/antigravity/scratch/usb-charger-master/public';
const rulesFile = 'C:/Users/ROOM_A/.gemini/antigravity/scratch/usb-charger-master/firestore.rules';

console.log('====================================================');
console.log('🚀 เริ่มต้นการ Deploy โปรเจกต์:', projectId);
console.log('====================================================\n');

function httpsRequest(urlStr, options, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const reqOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = https.request(reqOptions, (res) => {
      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bodyBuf = Buffer.concat(chunks);
        const bodyText = bodyBuf.toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(bodyText); } catch(e) { parsed = bodyText; }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          reject({ status: res.statusCode, body: parsed });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function getAllFiles(dir, base = '') {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    const rel = (base ? base + '/' : '') + file;
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllFiles(filePath, rel));
    } else {
      results.push({ relPath: '/' + rel.replace(/\\/g, '/'), fullPath: filePath });
    }
  });
  return results;
}

async function deployHosting() {
  console.log('📦 [1/2] กำลัง Deploy Firebase Hosting (เว็บ Kiosk & Admin)...');
  const allFiles = getAllFiles(publicDir);
  console.log(`- ตรวจพบไฟล์ในโฟลเดอร์ public ทั้งหมด: ${allFiles.length} ไฟล์`);

  const fileHashMap = {};
  const hashToGzipBuffer = {};

  for (const f of allFiles) {
    const rawBuf = fs.readFileSync(f.fullPath);
    const gzBuf = zlib.gzipSync(rawBuf, { level: 9 });
    const hash = crypto.createHash('sha256').update(gzBuf).digest('hex');
    fileHashMap[f.relPath] = hash;
    hashToGzipBuffer[hash] = gzBuf;
  }

  // 1.1 สร้าง Version ใหม่ พร้อม Config จาก firebase.json (cleanUrls, rewrites)
  console.log('- กำลังสร้าง Hosting Version ใหม่บน Cloud พร้อม Routing Config...');
  const hostingConfig = {
    cleanUrls: true,
    rewrites: [
      { glob: '/admin', path: '/admin.html' },
      { glob: '/admin/**', path: '/admin.html' },
      { glob: '**', path: '/index.html' }
    ]
  };

  const createRes = await httpsRequest(`https://firebasehosting.googleapis.com/v1beta1/sites/${siteId}/versions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  }, JSON.stringify({ config: hostingConfig }));

  const versionName = createRes.name;
  console.log(`- Version สร้างสำเร็จ: ${versionName}`);

  // 1.2 Populate Files
  console.log('- กำลังตรวจสอบความแตกต่างของไฟล์ (Gzipped Hashes)...');
  const popRes = await httpsRequest(`https://firebasehosting.googleapis.com/v1beta1/${versionName}:populateFiles`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  }, JSON.stringify({ files: fileHashMap }));

  const requiredHashes = popRes.uploadRequiredHashes || [];
  const uploadUrl = popRes.uploadUrl;
  console.log(`- จำนวนไฟล์ที่ต้องอัปโหลดใหม่: ${requiredHashes.length} ไฟล์`);

  // 1.3 อัปโหลดไฟล์ gzipped
  for (let i = 0; i < requiredHashes.length; i++) {
    const h = requiredHashes[i];
    const gzBuf = hashToGzipBuffer[h];
    process.stdout.write(`  [${i + 1}/${requiredHashes.length}] กำลังอัปโหลด hash ${h.substring(0, 10)}... `);
    await httpsRequest(`${uploadUrl}/${h}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream'
      }
    }, gzBuf);
    console.log('✔');
  }

  // 1.4 Finalize Version
  console.log('- กำลัง Finalize Version...');
  await httpsRequest(`https://firebasehosting.googleapis.com/v1beta1/${versionName}?update_mask=status`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  }, JSON.stringify({ status: 'FINALIZED' }));

  // 1.5 Release Version
  console.log('- กำลัง Release สู่ระบบ Production...');
  await httpsRequest(`https://firebasehosting.googleapis.com/v1beta1/sites/${siteId}/releases?versionName=${versionName}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  }, JSON.stringify({ message: 'Auto Deploy: Hardened reliability, IG, Survey, and Admin overhaul' }));

  console.log('✅ Firebase Hosting Deploy สำเร็จ 100%!');
  console.log('   URL: https://usb-charger-project.web.app/\n');
}

async function deployFirestoreRules() {
  console.log('🛡️ [2/2] กำลัง Deploy Firestore Security Rules...');
  const rulesContent = fs.readFileSync(rulesFile, 'utf8');

  // 2.1 สร้าง Ruleset
  console.log('- กำลังสร้าง Ruleset ใหม่...');
  const rulesetRes = await httpsRequest(`https://firebaserules.googleapis.com/v1/projects/${projectId}/rulesets`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  }, JSON.stringify({
    source: {
      files: [
        {
          name: 'firestore.rules',
          content: rulesContent
        }
      ]
    }
  }));

  const rulesetName = rulesetRes.name;
  console.log(`- Ruleset สร้างสำเร็จ: ${rulesetName}`);

  // 2.2 อัปเดต release
  console.log('- กำลังนำ Ruleset ไปใช้งานกับ Cloud Firestore...');
  await httpsRequest(`https://firebaserules.googleapis.com/v1/projects/${projectId}/releases/cloud.firestore`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  }, JSON.stringify({
    release: {
      name: `projects/${projectId}/releases/cloud.firestore`,
      rulesetName: rulesetName
    },
    updateMask: 'rulesetName'
  }));

  console.log('✅ Firestore Rules Deploy สำเร็จ 100%!\n');
}

async function main() {
  try {
    await deployHosting();
    await deployFirestoreRules();
    console.log('====================================================');
    console.log('🎉 ทุกระบบอัปเดตขึ้น Firebase สำเร็จสมบูรณ์ 100% แล้วครับ!');
    console.log('====================================================');
  } catch (err) {
    console.error('❌ เกิดข้อผิดพลาดในการ Deploy:', JSON.stringify(err, null, 2));
    process.exit(1);
  }
}

main();
