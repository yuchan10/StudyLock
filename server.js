require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// ── [보안] CORS: 환경변수로 허용 도메인 제한 ──────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://localhost:5500'];

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] }
});

app.use(express.json({ limit: '10kb' }));
app.use(express.static(__dirname));

// ── [보안] CORS 미들웨어 ──────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin || ALLOWED_ORIGINS[0]);
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── [보안] Rate Limiter ───────────────────────────────────
const rateLimitMap = new Map();
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

// ── [보안] Google Client ID: 환경변수 ────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
if (!GOOGLE_CLIENT_ID) console.warn('⚠️  GOOGLE_CLIENT_ID 환경변수가 없습니다.');

// ── [보안] Google ID Token 검증 ───────────────────────────
async function verifyGoogleToken(token) {
  try {
    const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
    if (!res.ok) return null;
    const payload = await res.json();
    if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID) return null;
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// ── [보안] 서버 발급 세션 토큰 (HMAC 서명) ───────────────
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('⚠️  SESSION_SECRET 없음. 임시 키 사용 중.');

function createSessionToken(googleId, email) {
  const payload = JSON.stringify({ googleId, email, iat: Date.now(), exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifySessionToken(token) {
  try {
    const [b64, sig] = token.split('.');
    if (!b64 || !sig) return null;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
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
// credential은 절대 공개하지 않고 googleClientId만 반환
app.get('/api/config', rateLimit(30, 60 * 1000), (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || '' });
});

// ── [보안] Google 로그인 → 서버 세션 토큰 발급 ──────────
app.post('/api/auth/google', rateLimit(10, 60 * 1000), async (req, res) => {
  const { credential } = req.body;
  if (!credential || typeof credential !== 'string') return res.status(400).json({ error: '잘못된 요청입니다.' });
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

// ── 유저 데이터 저장소 ────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'userdata.json');
function loadUserData() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  return {};
}
function saveUserData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(userData, null, 2)); }
  catch (e) { console.error('저장 실패:', e.message); }
}
let userData = loadUserData();
setInterval(saveUserData, 30000);

// ── REST API: 데이터 불러오기 ─────────────────────────────
app.get('/api/progress/:googleId', rateLimit(60, 60 * 1000), requireAuth, (req, res) => {
  res.json(userData[req.params.googleId] || { totalStudySec: 0, points: 0 });
});

// ── REST API: 데이터 저장 ─────────────────────────────────
app.post('/api/progress/:googleId', rateLimit(30, 60 * 1000), requireAuth, (req, res) => {
  const { googleId } = req.params;
  const { totalStudySec, points } = req.body;

  // [보안] 타입·범위 검증
  if (!Number.isInteger(totalStudySec) || !Number.isInteger(points)) return res.status(400).json({ error: '정수만 허용됩니다.' });
  if (totalStudySec < 0 || totalStudySec > 86400) return res.status(400).json({ error: '비정상적인 공부 시간입니다.' });
  if (points < 0 || points > 864000) return res.status(400).json({ error: '비정상적인 포인트 값입니다.' });

  const existing = userData[googleId] || { totalStudySec: 0, points: 0 };
  // [보안] 한 번에 1시간 이상 증가 차단
  const maxIncrease = 3600;
  userData[googleId] = {
    totalStudySec: Math.min(totalStudySec, existing.totalStudySec + maxIncrease),
    points: Math.min(points, existing.points + maxIncrease / 6 * 10),
    lastSaved: new Date().toISOString()
  };
  saveUserData();
  res.json({ ok: true, data: userData[googleId] });
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

io.on('connection', (socket) => {
  console.log('접속:', socket.id);

  socket.on('joinMatch', (data) => {
    // [보안] 이름 sanitize + 길이 제한
    const name = (typeof data?.name === 'string' ? data.name : '사용자').slice(0, 30).replace(/[<>]/g, '');
    waitingUsers = waitingUsers.filter(u => u.googleId !== socket.session.googleId);
    waitingUsers.push({ id: socket.id, googleId: socket.session.googleId, name, status: 'idle', studySec: 0 });

    if (waitingUsers.length >= 3) {
      const groupId = 'group_' + crypto.randomBytes(8).toString('hex');
      const members = waitingUsers.splice(0, 3);
      groups[groupId] = { id: groupId, name: 'FOCUS GROUP ' + Math.floor(Math.random() * 900 + 100), members, adminId: members[0].id };
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
    member.status = 'studying';
    io.to(groupId).emit('groupUpdate', group);
  });

  socket.on('stopStudy', ({ groupId, sessionSec }) => {
    if (typeof groupId !== 'string' || !/^group_[a-f0-9]{16}$/.test(groupId)) return;
    if (!Number.isInteger(sessionSec) || sessionSec < 0 || sessionSec > 86400) return;
    const group = groups[groupId];
    if (!group) return;
    const member = group.members.find(m => m.id === socket.id);
    if (!member) return;
    member.status = 'idle';
    member.studySec += sessionSec;
    io.to(groupId).emit('groupUpdate', group);
  });

  socket.on('disconnect', () => {
    waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`서버 실행 중: http://localhost:${PORT}`));
