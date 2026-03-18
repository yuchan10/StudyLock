// 로컬 개발용 .env 로드 (배포 환경은 자체 환경변수 사용)
require('dotenv').config({ path: '.env' });
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const mongoose = require('mongoose');

// ── 환경변수 폴백 (Render 환경변수 미연결 시 기본값 사용) ──
if (!process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS = 'https://yuchan10.github.io';
}

const app = express();
const server = http.createServer(app);

// ── [보안] 프록시 뒤에서 실제 클라이언트 IP 신뢰 ──────────
// Render.com, Heroku 등 플랫폼에서 X-Forwarded-For 헤더를 올바르게 읽기 위해 필요
app.set('trust proxy', 1);

// ── [보안] CORS: 환경변수로 허용 도메인 제한 ──────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:5500'];

// ── [보안] Socket.io CORS 설정 (단일 출처 설정) ────────────
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'], credentials: true }
});

app.use(express.json({ limit: '10kb' }));
app.use(express.static(__dirname));

// ── [보안] CORS + 보안 헤더 미들웨어 (중복 제거, 단일화) ───
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── [보안] Rate Limiter (trust proxy 설정 후 req.ip 정상 동작) ──
const rateLimitMap = new Map();

// 만료된 항목 주기적 정리 (메모리 누수 방지)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now - entry.start > 60 * 60 * 1000) rateLimitMap.delete(key);
  }
}, 10 * 60 * 1000);

function rateLimit(maxReq, windowMs) {
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = rateLimitMap.get(key) || { count: 0, start: now };
    if (now - entry.start > windowMs) { entry.count = 1; entry.start = now; }
    else entry.count++;
    rateLimitMap.set(key, entry);
    if (entry.count > maxReq) return res.status(429).json({ error: '요청이 너무 많습니다.' });
    next();
  };
}

// ── [보안] Google Client ID & Session Secret ──────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const SESSION_SECRET = process.env.SESSION_SECRET;

// ── [보안] Google ID Token 검증 ───────────────────────────
async function verifyGoogleToken(token) {
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
    if (!res.ok) return null;
    const payload = await res.json();
    if (payload.aud !== GOOGLE_CLIENT_ID) return null;
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// ── [보안] 서버 발급 세션 토큰 (HMAC 서명) ───────────────
function createSessionToken(googleId, email) {
  const payload = JSON.stringify({
    googleId, email,
    iat: Date.now(),
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifySessionToken(token) {
  try {
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return null;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// ── [보안] 인증 미들웨어 ──────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '인증이 필요합니다.' });
  const session = verifySessionToken(token);
  if (!session) return res.status(401).json({ error: '유효하지 않거나 만료된 세션입니다.' });
  if (req.params.googleId && req.params.googleId !== session.googleId) {
    return res.status(403).json({ error: '권한이 없습니다.' });
  }
  req.session = session;
  next();
}

// ── [보안] 클라이언트 설정 공개 엔드포인트 ──────────────
app.get('/api/config', rateLimit(30, 60 * 1000), (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID });
});

// ── [보안] Google 로그인 → 서버 세션 토큰 발급 ──────────
app.post('/api/auth/google', rateLimit(10, 60 * 1000), async (req, res) => {
  const { credential } = req.body;
  if (!credential || typeof credential !== 'string') {
    return res.status(400).json({ error: '잘못된 요청입니다.' });
  }
  const payload = await verifyGoogleToken(credential);
  if (!payload) return res.status(401).json({ error: '유효하지 않은 Google 토큰입니다.' });
  const sessionToken = createSessionToken(payload.sub, payload.email);
  res.json({
    sessionToken,
    user: {
      googleId: payload.sub,
      name: payload.name || payload.given_name || '사용자',
      email: payload.email || '',
      picture: payload.picture || ''
    }
  });
});

// ── MongoDB 연결 ─────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB 연결 성공'))
  .catch(err => { console.error('❌ MongoDB 연결 실패:', err.message); process.exit(1); });

// ── 유저 데이터 스키마 ────────────────────────────────────
const userSchema = new mongoose.Schema({
  googleId:     { type: String, required: true, unique: true },
  totalStudySec: { type: Number, default: 0 },
  points:       { type: Number, default: 0 },
  lastSaved:    { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// ── REST API: 데이터 불러오기 ─────────────────────────────
app.get('/api/progress/:googleId', rateLimit(60, 60 * 1000), requireAuth, async (req, res) => {
  try {
    const user = await User.findOne({ googleId: req.params.googleId });
    res.json(user ? { totalStudySec: user.totalStudySec, points: user.points } : { totalStudySec: 0, points: 0 });
  } catch (e) {
    res.status(500).json({ error: 'DB 오류' });
  }
});

// ── REST API: 데이터 저장 ─────────────────────────────────
app.post('/api/progress/:googleId', rateLimit(30, 60 * 1000), requireAuth, async (req, res) => {
  const { googleId } = req.params;
  const { totalStudySec, points } = req.body;

  if (!Number.isInteger(totalStudySec) || !Number.isInteger(points)) {
    return res.status(400).json({ error: '정수만 허용됩니다.' });
  }
  if (totalStudySec < 0 || totalStudySec > 86400) {
    return res.status(400).json({ error: '비정상적인 공부 시간입니다.' });
  }
  if (points < 0 || points > 864000) {
    return res.status(400).json({ error: '비정상적인 포인트 값입니다.' });
  }

  try {
    const existing = await User.findOne({ googleId }) || { totalStudySec: 0, points: 0 };
    const maxIncrease = 3600;
    const updated = await User.findOneAndUpdate(
      { googleId },
      {
        $set: {
          totalStudySec: Math.min(totalStudySec, existing.totalStudySec + maxIncrease),
          points: Math.min(points, existing.points + Math.floor(maxIncrease / 6) * 10),
          lastSaved: new Date()
        }
      },
      { upsert: true, new: true }
    );
    res.json({ ok: true, data: { totalStudySec: updated.totalStudySec, points: updated.points } });
  } catch (e) {
    res.status(500).json({ error: 'DB 오류' });
  }
});

// ── Socket.io: 인증 미들웨어 ──────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('소켓 인증 토큰이 없습니다.'));
  const session = verifySessionToken(token);
  if (!session) return next(new Error('유효하지 않은 소켓 토큰입니다.'));
  socket.session = session;
  next();
});

// ── Socket.io: 실시간 그룹 매칭 ───────────────────────────
let waitingUsers = [];
let groups = {};
let activeSessions = {};

// ── [보안] 유저가 이미 그룹에 속해있는지 확인 ────────────
function findGroupByGoogleId(googleId) {
  for (const [groupId, group] of Object.entries(groups)) {
    if (group.members.some(m => m.googleId === googleId)) return groupId;
  }
  return null;
}

io.on('connection', (socket) => {
  console.log('접속:', socket.id, '|', socket.session.googleId);

  socket.on('joinMatch', (data) => {
    const name = (typeof data?.name === 'string' ? data.name : '사용자')
      .slice(0, 30)
      .replace(/[<>]/g, '');

    // [보안] 이미 그룹에 속한 유저는 재매칭 무시하고 기존 그룹 복원
    const existingGroupId = findGroupByGoogleId(socket.session.googleId);
    if (existingGroupId) {
      const group = groups[existingGroupId];
      // 소켓 ID 갱신 (재접속 시)
      const member = group.members.find(m => m.googleId === socket.session.googleId);
      if (member) member.id = socket.id;
      socket.join(existingGroupId);
      socket.emit('matchComplete', { groupId: existingGroupId, groupData: group, myId: socket.id });
      return;
    }

    // 대기열에서 같은 googleId 중복 제거 후 재추가
    waitingUsers = waitingUsers.filter(u => u.googleId !== socket.session.googleId);
    waitingUsers.push({ id: socket.id, googleId: socket.session.googleId, name, status: 'idle', studySec: 0 });

    if (waitingUsers.length >= 3) {
      const groupId = 'group_' + crypto.randomBytes(8).toString('hex');
      const members = waitingUsers.splice(0, 3);
      groups[groupId] = {
        id: groupId,
        name: 'FOCUS GROUP ' + Math.floor(Math.random() * 900 + 100),
        members,
        adminId: members[0].id
      };
      members.forEach(m => {
        io.sockets.sockets.get(m.id)?.join(groupId);
        io.to(m.id).emit('matchComplete', { groupId, groupData: groups[groupId], myId: m.id });
      });
    }
  });

  socket.on('startStudy', (groupId) => {
    if (typeof groupId !== 'string' || !/^group_[a-f0-9]{16}$/.test(groupId)) return;
    const group = groups[groupId];
    if (!group) return;
    const member = group.members.find(m => m.id === socket.id);
    if (!member) return;
    if (activeSessions[socket.session.googleId]) return;
    activeSessions[socket.session.googleId] = { startTime: Date.now(), groupId };
    member.status = 'studying';
    io.to(groupId).emit('groupUpdate', group);
  });

  socket.on('stopStudy', ({ groupId }) => {
    if (typeof groupId !== 'string' || !/^group_[a-f0-9]{16}$/.test(groupId)) return;
    const group = groups[groupId];
    if (!group) return;
    const member = group.members.find(m => m.id === socket.id);
    if (!member) return;
    const session = activeSessions[socket.session.googleId];
    if (!session) return;
    const sessionSec = Math.floor((Date.now() - session.startTime) / 1000);
    delete activeSessions[socket.session.googleId];
    member.status = 'idle';
    member.studySec += sessionSec;
    io.to(groupId).emit('groupUpdate', group);
    socket.emit('sessionResult', { sessionSec });
  });

  // ── [수정] 솔로 모드: 서버에서 시간 계산 ────────────────
  socket.on('startStudySolo', () => {
    if (activeSessions[socket.session.googleId]) return;
    activeSessions[socket.session.googleId] = { startTime: Date.now(), groupId: null };
  });

  socket.on('stopStudySolo', () => {
    const session = activeSessions[socket.session.googleId];
    if (!session) return;
    const sessionSec = Math.floor((Date.now() - session.startTime) / 1000);
    delete activeSessions[socket.session.googleId];
    socket.emit('sessionResult', { sessionSec });
  });

  socket.on('disconnect', () => {
    waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
    delete activeSessions[socket.session.googleId];
    console.log('퇴장:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));