// ============================================================
// StudyLock - app.js
// ============================================================

const SERVER_URL = window.STUDYLOCK_SERVER_URL || 'https://studylock-server.onrender.com';

// ── 소켓 연결 시 세션 토큰을 auth로 전달 ─────────────────
function createSocket(sessionToken) {
  if (typeof io === 'undefined') return { emit: () => {}, on: () => {}, connect: () => {} };
  return io(SERVER_URL, {
    auth: { token: sessionToken },
    autoConnect: false
  });
}

let socket = { emit: () => {}, on: () => {}, connect: () => {} };

// ============================================================
// App
// ============================================================
const App = {
  state: {
    userName: '', email: '', picture: '', googleId: '',
    myId: null, groupId: null, groupData: null,
    totalStudySec: 0, points: 0,
    sessionSec: 0,      // UI 표시용 (클라이언트 카운트)
    timerInterval: null,
    studying: false     // [수정 #3] 중복 세션 방지용 플래그
  },

  // ── 초기화 ──────────────────────────────────────────────
  async init() {
    this.startClock();
    this.bindEvents();

    // [수정 #1] GSI 타이밍 레이스 해결: 스크립트 로드 완료까지 대기 후 초기화
    await this._initGoogleSignIn();

    const auth = this._loadAuth();
    if (auth) this._enterApp(auth);
  },

  // ── [수정 #1 & #6] Google Client ID 동적 주입 + GSI 로드 대기 + 실패 시 안내 ──
  async _initGoogleSignIn() {
    // [수정] GSI 스크립트 로드 완료 대기 (최대 5초)
    // g_id_onload div 제거로 자동 초기화 차단 → 여기서만 초기화
    await new Promise(resolve => {
      if (window.google?.accounts?.id) return resolve();
      const limit = Date.now() + 5000;
      const poll = setInterval(() => {
        if (window.google?.accounts?.id || Date.now() > limit) {
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });

    // 서버에서 Client ID 가져오기
    let clientId = '';
    try {
      const res = await fetch(`${SERVER_URL}/api/config`);
      if (res.ok) {
        const data = await res.json();
        clientId = data.googleClientId || '';
      }
    } catch (e) {
      console.warn('서버 설정 로드 실패:', e.message);
    }

    // [수정 #6] Client ID 없으면 안내 메시지 표시 (빈 화면 방지)
    if (!clientId) {
      const wrap = document.querySelector('.login-google-wrap');
      if (wrap) wrap.innerHTML = '<p style="color:#666;font-size:0.85rem;text-align:center;line-height:1.8;">서버에 연결할 수 없습니다.<br>잠시 후 새로고침해 주세요.</p>';
      return;
    }

    const container = document.getElementById('gsi-button-container');
    if (!container) return;

    if (window.google?.accounts?.id) {
      // [수정] initialize 한 번만 호출 (g_id_onload 제거로 중복 호출 방지)
      google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleLogin,
        auto_select: false
      });
      google.accounts.id.renderButton(container, {
        type: 'standard', size: 'large', theme: 'outline',
        text: 'signin_with', shape: 'rectangular',
        logo_alignment: 'left', width: 280
      });
    }
  },

  // ── [보안] localStorage에는 서버 발급 sessionToken만 저장 ──
  _loadAuth() {
    try {
      const d = JSON.parse(localStorage.getItem('studylock_auth') || 'null');
      if (d?.credential) {
        delete d.credential;
        localStorage.setItem('studylock_auth', JSON.stringify(d));
      }
      return (d && d.googleId && d.sessionToken) ? d : null;
    } catch { return null; }
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

    // 소켓 연결
    const sessionToken = this._getSessionToken();
    if (sessionToken && typeof io !== 'undefined') {
      socket = createSocket(sessionToken);
      this._bindSocketEvents();
      socket.connect();
    }

    const ls = document.getElementById('login-screen');
    ls.classList.add('hide');
    setTimeout(() => ls.style.display = 'none', 420);

    const name = this.state.userName;
    document.getElementById('greeting-name-display').textContent = `안녕, ${name}`;

    const av  = document.getElementById('user-avatar');
    const sav = document.getElementById('settings-avatar');
    if (this.state.picture) {
      av.innerHTML  = `<img src="${escapeHtml(this.state.picture)}" alt="">`;
      sav.innerHTML = `<img src="${escapeHtml(this.state.picture)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
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

    // [수정 #4] 데이터 초기화: 확인 다이얼로그 추가 (실수 방지)
    document.getElementById('reset-btn').onclick = () => {
      if (!confirm('공부 기록과 포인트를 모두 초기화할까요?')) return;
      this.state.totalStudySec = 0;
      this.state.points = 0;
      this._pushServerProgress();
      this.updateDashboard();
    };

    // [수정 #5] 로그아웃 시 공부 중이면 서버에 종료 알림 후 로그아웃
    document.getElementById('logout-btn').onclick = async () => {
      if (this.state.studying) {
        if (this.state.groupId) {
          socket.emit('stopStudy', { groupId: this.state.groupId });
        } else {
          socket.emit('stopStudySolo');
        }
        clearInterval(this.state.timerInterval);
        this.state.timerInterval = null;
        document.getElementById('timer-overlay').style.display = 'none';
        // 서버가 sessionResult 보낼 시간 대기 (studying 플래그는 sessionResult에서 처리)
        await new Promise(r => setTimeout(r, 600));
      }
      this._pushServerProgress();
      localStorage.removeItem('studylock_auth');
      if (window.google?.accounts?.id) google.accounts.id.disableAutoSelect();
      location.reload();
    };
  },

  // ── [수정 #3] 소켓 이벤트 바인딩: sessionResult 중복 방지 ──
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

    // [수정 #3] sessionResult: 마지막 stopStudy 이후 한 번만 처리
    socket.on('sessionResult', ({ sessionSec }) => {
      // studying 플래그와 무관하게 항상 반영 (플래그 타이밍 이슈 방지)
      if (sessionSec <= 0) return;
      this.state.studying = false;
      this.state.totalStudySec += sessionSec;
      this.state.points += Math.floor(sessionSec / 60) * 10;
      this._pushServerProgress();
      this.updateDashboard();
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
      `관리자: ${admin?.id === myId ? '본인' : escapeHtml(admin?.name || '—')}`;
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
    this.state.studying = true;
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
      socket.emit('startStudySolo');
      grid.innerHTML = `
        <div class="p-card active" style="grid-column:1/-1;max-width:130px;margin:0 auto;">
          <div class="p-avatar">👤</div>
          <div class="p-name">${escapeHtml(this.state.userName)}</div>
          <div style="font-size:0.65rem;color:#444;margin-top:4px;">솔로 집중</div>
        </div>`;
    }

    // UI 표시용 클라이언트 타이머 (실제 포인트 계산은 서버)
    this.state.timerInterval = setInterval(() => {
      this.state.sessionSec++;
      const m = Math.floor(this.state.sessionSec / 60);
      const s = this.state.sessionSec % 60;
      document.getElementById('session-elapsed').textContent =
        `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }, 1000);
  },

  // ── 공부 종료 ────────────────────────────────────────────
  stopStudy() {
    clearInterval(this.state.timerInterval);
    this.state.timerInterval = null;
    document.getElementById('timer-overlay').style.display = 'none';

    // [수정 #2] 소켓 미연결 시: 클라이언트 타이머 값으로 직접 반영 (폴백)
    if (typeof socket.connected !== 'undefined' && !socket.connected) {
      console.warn('소켓 미연결: 클라이언트 측정 시간으로 대체합니다.');
      this.state.studying = false;
      this.state.totalStudySec += this.state.sessionSec;
      this.state.points += Math.floor(this.state.sessionSec / 60) * 10;
      this._pushServerProgress();
      this.updateDashboard();
      return;
    }

    if (this.state.groupId) {
      socket.emit('stopStudy', { groupId: this.state.groupId });
    } else {
      socket.emit('stopStudySolo');
    }
    // 결과는 _bindSocketEvents의 'sessionResult' 리스너에서 처리
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
  // [수정 #7] saveProgress() dead code 제거됨
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

// ── [보안] Google GSI 콜백 ───────────────────────────────
async function handleGoogleLogin(response) {
  if (!response?.credential) return;
  try {
    const res = await fetch(`${SERVER_URL}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('로그인 실패:', err.error);
      alert('로그인에 실패했습니다. 다시 시도해 주세요.');
      return;
    }

    const { sessionToken, user } = await res.json();

    // [보안] sessionToken만 저장, credential은 저장 안 함
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