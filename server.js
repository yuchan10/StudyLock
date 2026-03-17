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

// ── CORS (GitHub Pages → Railway 요청 허용) ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── 유저 데이터 저장소 (메모리 + JSON 파일 백업) ──
const DATA_FILE = path.join(__dirname, 'userdata.json');

function loadUserData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveUserData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(userData, null, 2));
  } catch (e) {
    console.error('저장 실패:', e.message);
  }
}

let userData = loadUserData(); // { [googleId]: { totalStudySec, points, lastSaved } }

// 30초마다 파일에 백업
setInterval(saveUserData, 30000);

// ── REST API: 데이터 불러오기 ──
app.get('/api/progress/:googleId', (req, res) => {
  const { googleId } = req.params;
  const data = userData[googleId] || { totalStudySec: 0, points: 0 };
  res.json(data);
});

// ── REST API: 데이터 저장 ──
app.post('/api/progress/:googleId', (req, res) => {
  const { googleId } = req.params;
  const { totalStudySec, points } = req.body;
  if (typeof totalStudySec !== 'number' || typeof points !== 'number') {
    return res.status(400).json({ error: 'invalid data' });
  }
  // 더 큰 값 기준으로 머지 (두 기기 중 더 많이 공부한 쪽 유지)
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