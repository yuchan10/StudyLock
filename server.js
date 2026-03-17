const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(__dirname));

// ── CORS ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Google ID Token 검증 ──
// 외부 라이브러리 없이 Google의 공개 API로 검증
async function verifyGoogleToken(token) {
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
    if (!res.ok) return null;
    const payload = await res.json();
    // 클라이언트 ID가 맞는지 확인
    if (payload.aud !== '873434718410-v9k4a2ug741j8ka6sc5mnqjmobb7a2f0.apps.googleusercontent.com') return null;
    return payload; // { sub: googleId, email, name, ... }
  } catch { return null; }
}

// ── 인증 미들웨어 ──
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '토큰 없음' });

  const payload = await verifyGoogleToken(token);
  if (!payload) return res.status(401).json({ error: '유효하지 않은 토큰' });

  // URL의 googleId와 토큰의 sub(실제 구글ID)가 일치하는지 확인
  if (req.params.googleId && req.params.googleId !== payload.sub) {
    return res.status(403).json({ error: '권한 없음' });
  }

  req.googleUser = payload;
  next();
}

// ── 유저 데이터 저장소 ──
const DATA_FILE = path.join(__dirname, 'userdata.json');

function loadUserData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {}
  return {};
}

function saveUserData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(userData, null, 2)); }
  catch (e) { console.error('저장 실패:', e.message); }
}

let userData = loadUserData();
setInterval(saveUserData, 30000);

// ── REST API: 데이터 불러오기 (인증 필요) ──
app.get('/api/progress/:googleId', requireAuth, (req, res) => {
  const data = userData[req.params.googleId] || { totalStudySec: 0, points: 0 };
  res.json(data);
});

// ── REST API: 데이터 저장 (인증 필요) ──
app.post('/api/progress/:googleId', requireAuth, (req, res) => {
  const { googleId } = req.params;
  const { totalStudySec, points } = req.body;
  if (typeof totalStudySec !== 'number' || typeof points !== 'number') {
    return res.status(400).json({ error: 'invalid data' });
  }
  const existing = userData[googleId] || { totalStudySec: 0, points: 0 };
  userData[googleId] = {
    totalStudySec: Math.max(existing.totalStudySec, totalStudySec),
    points:        Math.max(existing.points, points),
    lastSaved:     new Date().toISOString()
  };
  saveUserData();
  res.json({ ok: true, data: userData[googleId] });
});

// ── Socket.io (실시간 그룹 매칭) ──
let waitingUsers = [];
let groups = {};

io.on('connection', (socket) => {
  console.log('접속:', socket.id);

  socket.on('joinMatch', (userData) => {
    userData.id = socket.id;
    userData.status = 'idle';
    userData.studySec = 0;
    waitingUsers.push(userData);

    if (waitingUsers.length >= 3) {
      const groupId = 'group_' + Date.now();
      const members = waitingUsers.splice(0, 3);
      groups[groupId] = {
        id: groupId,
        name: 'FOCUS GROUP ' + Math.floor(Math.random() * 900 + 100),
        members,
        adminId: members[Math.floor(Math.random() * members.length)].id
      };
      members.forEach(m => {
        socket.join(groupId);
        io.to(m.id).emit('matchComplete', {
          groupId,
          groupData: groups[groupId],
          myId: m.id
        });
      });
    }
  });

  socket.on('startStudy', (groupId) => {
    if (groups[groupId]) {
      const member = groups[groupId].members.find(m => m.id === socket.id);
      if (member) member.status = 'studying';
      io.to(groupId).emit('groupUpdate', groups[groupId]);
    }
  });

  socket.on('stopStudy', ({ groupId, sessionSec }) => {
    if (groups[groupId]) {
      const member = groups[groupId].members.find(m => m.id === socket.id);
      if (member) { member.status = 'idle'; member.studySec += sessionSec; }
      io.to(groupId).emit('groupUpdate', groups[groupId]);
    }
  });

  socket.on('disconnect', () => {
    waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));