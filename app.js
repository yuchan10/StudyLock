// ============================================================
// StudyLock - app.js (보안 수정본)
// ============================================================

// ★ 배포 후 본인 서버 URL로 교체하세요 (환경변수 방식 권장)
const SERVER_URL = window.STUDYLOCK_SERVER_URL || 'https://studylock-server.onrender.com';

// ── [보안] 소켓 연결 시 세션 토큰을 auth로 전달 ─────────
function createSocket(sessionToken) {
  if (typeof io === 'undefined') return { emit: () => {}, on: () => {} };
  return io(SERVER_URL, {
    auth: { token: sessionToken },
    autoConnect: false
  });
}

let socket = { emit: () => {}, on: () => {} };

// ============================================================
// App
// ============================================================
const App = {
  state: {
    userName: '', email: '', picture: '', googleId: '',
    myId: null, groupId: null, groupData: null,
    totalStudySec: 0, points: 0, sessionSec: 0, timerInterval: null
  },

  // ── 초기화 ──────────────────────────────────────────────
  init() {
    this.startClock();
    this.bindEvents();
    const auth = this._loadAuth();
    if (auth) this._enterApp(auth);
  },

  // ── [보안] localStorage에는 서버 발급 sessionToken만 저장 ──
  _loadAuth() {
    try {
      const d = JSON.parse(localStorage.getItem('studylock_auth') || 'null');
      // credential(Google 원본 토큰) 이 남아있으면 제거
      if (d?.credential) {
        delete d.credential;
        localStorage.setItem('studylock_auth', JSON.stringify(d));
      }
      return (d && d.googleId && d.sessionToken) ? d : null;
    } catch { return null; }
  },

  // ── 진행 데이터 (로컬) ──────────────────────────────────
  _loadLocalProgress() {
    try {
      const d = JSON.parse(localStorage.getItem('studylock_progress') || '{}');
      return { totalStudySec: d.totalStudySec || 0, points: d.points || 0 };
    } catch { return { totalStudySec: 0, points: 0 }; }
  },

  // ── 진행 데이터 (서버) ───────────────────────────────────
  async _fetchServerProgress(googleId) {
    try {
      const token = this._getSessionToken();
      if (!token) return null;
      const res = await fetch(`${SERVER_URL}/api/progress/${googleId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.status === 401) { this._forceLogout(); return null; }
      if (!res.ok) throw new Error();
      return await res.json();
    } catch { return null; }
  },

  // ── 진행 데이터 (서버 저장) ──────────────────────────────
  async _pushServerProgress() {
    if (!this.state.googleId) return;
    try {
      const token = this._getSessionToken();
      if (!token) return;
      const res = await fetch(`${SERVER_URL}/api/progress/${this.state.googleId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          totalStudySec: Math.floor(this.state.totalStudySec),
          points: Math.floor(this.state.points)
        })
      });
      if (res.status === 401) this._forceLogout();
    } catch {}
  },

  // ── [보안] Google 원본 credential 대신 서버 세션 토큰 사용 ──
  _getSessionToken() {
    try {
      const auth = JSON.parse(localStorage.getItem('studylock_auth') || 'null');
      return auth?.sessionToken || null;
    } catch { return null; }
  },

  // ── [보안] 세션 만료 시 강제 로그아웃 ───────────────────
  _forceLogout() {
    localStorage.removeItem('studylock_auth');
    localStorage.removeItem('studylock_progress');
    alert('세션이 만료되었습니다. 다시 로그인해 주세요.');
    location.reload();
  },

  // ── 앱 진입 ──────────────────────────────────────────────
  async _enterApp(user) {
    this.state.userName = user.name || user.userName || '사용자';
    this.state.email    = user.email    || '';
    this.state.picture  = user.picture  || '';
    this.state.googleId = user.googleId || '';

    const server = await this._fetchServerProgress(this.state.googleId);
    this.state.totalStudySec = server?.totalStudySec || 0;
    this.state.points = server?.points || 0;

    // 소켓 연결 (세션 토큰 포함)
    const sessionToken = this._getSessionToken();
    if (sessionToken && typeof io !== 'undefined') {
      socket = createSocket(sessionToken);
      this._bindSocketEvents();
      socket.connect();
    }

    // 로그인 화면 숨기기
    const ls = document.getElementById('login-screen');
    ls.classList.add('hide');
    setTimeout(() => ls.style.display = 'none', 420);

    const name = this.state.userName;
    document.getElementById('greeting-name-display').textContent = `안녕, ${name}`;

    const av  = document.getElementById('user-avatar');
    const sav = document.getElementById('settings-avatar');
    if (this.state.picture) {
      av.innerHTML  = `<img src="${this.state.picture}" alt="">`;
      sav.innerHTML = `<img src="${this.state.picture}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    } else {
      av.textContent  = name[0];
      sav.textContent = name[0];
    }
    document.getElementById('settings-name').textContent  = name;
    document.getElementById('settings-email').textContent = this.state.email || '—';

    this.updateDashboard();
    socket.emit('joinMatch', { name });
  },

  // ── 이벤트 바인딩 ────────────────────────────────────────
  bindEvents() {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        document.getElementById(btn.dataset.tab + '-panel').classList.add('active');
        btn.classList.add('active');
      };
    });

    document.getElementById('study-btn').onclick        = () => this.startStudy();
    document.getElementById('overlay-stop-btn').onclick = () => this.stopStudy();

    document.getElementById('reset-btn').onclick = () => {
      localStorage.removeItem('studylock_progress');
      this.state.totalStudySec = 0;
      this.state.points = 0;
      this.updateDashboard();
    };

    document.getElementById('logout-btn').onclick = () => {
      if (this.state.timerInterval) {
        clearInterval(this.state.timerInterval);
        this.state.points += Math.floor(this.state.sessionSec / 60) * 10;
      }
      this.saveProgress();
      localStorage.removeItem('studylock_auth');
      if (window.google?.accounts?.id) google.accounts.id.disableAutoSelect();
      location.reload();
    };
  },

  // ── 소켓 이벤트 바인딩 ───────────────────────────────────
  _bindSocketEvents() {
    socket.on('matchComplete', (data) => {
      this.state.groupId   = data.groupId;
      this.state.groupData = data.groupData;
      this.state.myId      = data.myId;
      this.renderGroupInfo();
    });
    socket.on('groupUpdate', (data) => {
      this.state.groupData = data;
      this.renderGroupInfo();
    });
    socket.on('connect_error', (err) => {
      console.warn('소켓 연결 실패:', err.message);
    });
  },

  // ── 그룹 정보 렌더링 ─────────────────────────────────────
  renderGroupInfo() {
    const { groupData, myId } = this.state;
    if (!groupData) return;
    document.getElementById('group-name').textContent = groupData.name;
    const admin = groupData.members.find(m => m.id === groupData.adminId);
    document.getElementById('group-controller').textContent =
      `관리자: ${admin?.id === myId ? '본인' : admin?.name}`;
    const sorted = [...groupData.members].sort((a, b) => b.studySec - a.studySec);
    document.getElementById('my-rank').textContent = `#${sorted.findIndex(m => m.id === myId) + 1}위`;
    document.getElementById('leaderboard-list').innerHTML = sorted.map((m, i) => `
      <div style="display:flex;justify-content:space-between;align-items:center;
                  padding:15px;background:var(--surface);
                  border:1px solid ${m.id === myId ? '#fff' : '#222'};
                  border-radius:12px;margin-bottom:8px;">
        <span style="font-weight:${m.id === myId ? 700 : 400};color:${m.id === myId ? '#fff' : '#aaa'}">
          ${i + 1}. ${escapeHtml(m.name)}${m.id === myId ? ' (나)' : ''}
        </span>
        <span style="font-size:0.82rem;color:${m.status === 'studying' ? '#fff' : '#444'}">
          ${m.status === 'studying' ? '● 집중 중' : Math.floor(m.studySec / 60) + '분'}
        </span>
      </div>`).join('');
  },

  // ── 공부 시작 ────────────────────────────────────────────
  startStudy() {
    document.getElementById('timer-overlay').style.display = 'flex';
    this.state.sessionSec = 0;
    const grid = document.getElementById('participant-grid');

    if (this.state.groupId) {
      socket.emit('startStudy', this.state.groupId);
      grid.innerHTML = this.state.groupData.members.map(m => `
        <div class="p-card ${m.id === this.state.myId ? 'active' : ''}">
          <div class="p-avatar">👤</div>
          <div class="p-name">${escapeHtml(m.name)}</div>
        </div>`).join('');
    } else {
      grid.innerHTML = `
        <div class="p-card active" style="grid-column:1/-1;max-width:130px;margin:0 auto;">
          <div class="p-avatar">👤</div>
          <div class="p-name">${escapeHtml(this.state.userName)}</div>
          <div style="font-size:0.65rem;color:#444;margin-top:4px;">솔로 집중</div>
        </div>`;
    }

    this.state.timerInterval = setInterval(() => {
      this.state.sessionSec++;
      this.state.totalStudySec++;
      const m = Math.floor(this.state.sessionSec / 60);
      const s = this.state.sessionSec % 60;
      document.getElementById('session-elapsed').textContent =
        `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      if (this.state.sessionSec % 10 === 0) this.saveProgress();
    }, 1000);
  },

  // ── 공부 종료 ────────────────────────────────────────────
  stopStudy() {
    clearInterval(this.state.timerInterval);
    document.getElementById('timer-overlay').style.display = 'none';
    this.state.points += Math.floor(this.state.sessionSec / 60) * 10;
    socket.emit('stopStudy', { groupId: this.state.groupId, sessionSec: this.state.sessionSec });
    this.saveProgress();
    this.updateDashboard();
  },

  // ── 대시보드 업데이트 ─────────────────────────────────────
  updateDashboard() {
    const min = Math.floor(this.state.totalStudySec / 60);
    document.getElementById('study-time-display').textContent  = `${min}분`;
    document.getElementById('total-study-min').textContent     = min;
    document.getElementById('points-display').textContent      = this.state.points;
    document.getElementById('total-points-stat').textContent   = this.state.points + ' pt';
    document.getElementById('study-progress-fill').style.width = Math.min((min / 120) * 100, 100) + '%';
  },

  // ── 데이터 저장 ──────────────────────────────────────────
  saveProgress() {
    this._pushServerProgress();
  },

  // ── 시계 ─────────────────────────────────────────────────
  startClock() {
    const tick = () => {
      const n = new Date();
      document.getElementById('clock').textContent =
        String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0');
    };
    tick();
    setInterval(tick, 1000);
  }
};

// ── [보안] XSS 방지용 HTML 이스케이프 ────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── 앱 시작 ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());

// ── [보안] Google GSI 콜백: credential을 서버로 보내 세션 토큰 교환 ──
async function handleGoogleLogin(response) {
  if (!response?.credential) return;
  try {
    const res = await fetch(`${SERVER_URL}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
      // [보안] credential은 서버로만 전송하고 localStorage에 저장하지 않음
    });

    if (!res.ok) {
      const err = await res.json();
      console.error('로그인 실패:', err.error);
      alert('로그인에 실패했습니다. 다시 시도해 주세요.');
      return;
    }

    const { sessionToken, user } = await res.json();

    // [보안] sessionToken(서버 발급)만 저장, Google credential은 저장 안 함
    localStorage.setItem('studylock_auth', JSON.stringify({
      googleId:     user.googleId,
      name:         user.name,
      email:        user.email,
      picture:      user.picture,
      sessionToken: sessionToken
    }));

    App._enterApp({ ...user, sessionToken });
  } catch (e) {
    console.error('Google 로그인 오류:', e);
    alert('로그인 중 오류가 발생했습니다.');
  }
}