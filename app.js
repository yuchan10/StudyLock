// ============================================================
// StudyLock - app.js
// ============================================================

// socket.io 서버 없을 때 폴백
const socket = (typeof io !== 'undefined') ? io() : { emit: () => {}, on: () => {} };

// ★ Railway 배포 후 본인 서버 URL로 교체하세요
const SERVER_URL = 'https://studylock-server.onrender.com';

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
    if (auth) {
      this._enterApp(auth);
    }
    // 미로그인이면 login-screen이 그대로 표시됨
  },

  // ── 인증 ────────────────────────────────────────────────
  _loadAuth() {
    try {
      const d = JSON.parse(localStorage.getItem('studylock_auth') || 'null');
      return (d && (d.googleId || d.name)) ? d : null;
    } catch { return null; }
  },

  // ── 진행 데이터 (로컬) ──────────────────────────────────
  _loadLocalProgress() {
    try {
      const d = JSON.parse(localStorage.getItem('studylock_progress') || '{}');
      return { totalStudySec: d.totalStudySec || 0, points: d.points || 0 };
    } catch { return { totalStudySec: 0, points: 0 }; }
  },

  // ── 진행 데이터 (서버에서 불러오기) ─────────────────────
  async _fetchServerProgress(googleId) {
    try {
      const token = this._getToken();
      if (!token) return null;
      const res = await fetch(`${SERVER_URL}/api/progress/${googleId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error();
      return await res.json();
    } catch {
      return null; // 서버 연결 실패 시 로컬 데이터 사용
    }
  },

  // ── 진행 데이터 (서버에 저장) ────────────────────────────
  async _pushServerProgress() {
    if (!this.state.googleId) return;
    try {
      const token = this._getToken();
      if (!token) return;
      await fetch(`${SERVER_URL}/api/progress/${this.state.googleId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          totalStudySec: this.state.totalStudySec,
          points: this.state.points
        })
      });
    } catch {} // 실패해도 로컬엔 저장됨
  },

  // ── Google 토큰 가져오기 ──────────────────────────────────
  _getToken() {
    try {
      const auth = JSON.parse(localStorage.getItem('studylock_auth') || 'null');
      return auth?.credential || null;
    } catch { return null; }
  },

  // ── 앱 진입 (로그인 성공 후) ─────────────────────────────
  async _enterApp(user) {
    this.state.userName = user.name || user.userName || '사용자';
    this.state.email    = user.email    || '';
    this.state.picture  = user.picture  || '';
    this.state.googleId = user.googleId || '';

    // 서버 데이터 우선, 없으면 로컬 폴백 — 둘 다 있으면 더 큰 값 사용
    const local  = this._loadLocalProgress();
    const server = await this._fetchServerProgress(this.state.googleId);
    this.state.totalStudySec = Math.max(local.totalStudySec, server?.totalStudySec || 0);
    this.state.points        = Math.max(local.points,        server?.points        || 0);

    // 로그인 화면 숨기기
    const ls = document.getElementById('login-screen');
    ls.classList.add('hide');
    setTimeout(() => ls.style.display = 'none', 420);

    // UI 업데이트
    const name = this.state.userName;
    document.getElementById('greeting-name-display').textContent = `안녕, ${name}`;

    const av  = document.getElementById('user-avatar');
    const sav = document.getElementById('settings-avatar');
    if (this.state.picture) {
      av.innerHTML  = `<img src="${this.state.picture}" alt="${name}">`;
      sav.innerHTML = `<img src="${this.state.picture}" alt="${name}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
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
    // 탭 전환
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

    // 데이터 초기화
    document.getElementById('reset-btn').onclick = () => {
      localStorage.removeItem('studylock_progress');
      this.state.totalStudySec = 0;
      this.state.points = 0;
      this.updateDashboard();
    };

    // 로그아웃 — 타이머 중이면 먼저 저장
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

    // 소켓 이벤트
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
          ${i + 1}. ${m.name}${m.id === myId ? ' (나)' : ''}
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
          <div class="p-name">${m.name}</div>
        </div>`).join('');
    } else {
      // 솔로 모드
      grid.innerHTML = `
        <div class="p-card active" style="grid-column:1/-1;max-width:130px;margin:0 auto;">
          <div class="p-avatar">👤</div>
          <div class="p-name">${this.state.userName}</div>
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
      // 10초마다 자동 저장
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

  // ── 데이터 저장 (로컬 + 서버) ────────────────────────────
  saveProgress() {
    localStorage.setItem('studylock_progress', JSON.stringify({
      totalStudySec: this.state.totalStudySec,
      points: this.state.points
    }));
    this._pushServerProgress(); // 비동기, 실패해도 로컬엔 저장됨
  },

  // ── 시계 ────────────────────────────────────────────────
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

// ── 앱 시작 ──────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());

// ── Google GSI 콜백 (전역 함수로 등록 필수) ──────────────
function handleGoogleLogin(response) {
  if (!response?.credential) return;
  try {
    const b64  = response.credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const data = JSON.parse(decodeURIComponent(
      atob(b64).split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    ));
    const user = {
      name:       data.name || data.given_name || '사용자',
      email:      data.email    || '',
      picture:    data.picture  || '',
      googleId:   data.sub      || '',
      credential: response.credential  // 서버 인증용 토큰 보관
    };
    localStorage.setItem('studylock_auth', JSON.stringify(user));
    App._enterApp(user);
  } catch (e) {
    console.error('Google 로그인 오류:', e);
  }
}