// ============================================================
// StudyLock - app.js (Minimalist B/W & No Confirm)
// ============================================================

const Auth = (() => {
  const AUTH_KEY = 'studylock_auth';

  // JWT 페이로드 파싱 (Google credential 디코딩용)
  function _parseJwt(token) {
    try {
      const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(
        atob(base64).split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
      );
      return JSON.parse(json);
    } catch { return null; }
  }

  function getUser() {
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  // Google 콜백에서 credential(JWT) 받아 저장
  function loginWithCredential(credential) {
    const payload = _parseJwt(credential);
    if (!payload) return null;
    const user = {
      name: payload.name || payload.given_name || '사용자',
      email: payload.email || '',
      picture: payload.picture || '',
      googleId: payload.sub || '',
    };
    localStorage.setItem(AUTH_KEY, JSON.stringify(user));
    return user;
  }

  function logout() {
    localStorage.removeItem(AUTH_KEY);
    if (window.google && google.accounts && google.accounts.id) {
      google.accounts.id.disableAutoSelect();
    }
  }

  // googleId 또는 name 둘 다 허용 (하위 호환)
  function isLoggedIn() {
    const user = getUser();
    return !!(user && (user.googleId || (user.name && user.name.length > 0)));
  }

  return { getUser, loginWithCredential, logout, isLoggedIn };
})();

const Storage = (() => {
  const KEY = 'studylock_data';

  function _defaultState(userName) {
    const name = userName || '지민';
    const today = _dateKey();
    return {
      user: { name: name, avatar: name },
      goal: 4 * 3600,
      points: 340,
      streak: 7,
      daily: {
        [today]: {
          studySec: 0,
          appLimits: {
            '게임': { limitSec: 1800, usedSec: 1740, icon: '🎮' },
            'SNS':  { limitSec: 1800, usedSec: 1023, icon: '💬' },
            '유튜브':{ limitSec: 1800, usedSec: 600,  icon: '▶' },
          }
        }
      },
      group: {
        name: '집중 1조',
        type: 'Chain',
        members: [
          { name: '민준' },
          { name: '지민', isSelf: true },
          { name: '수현' },
        ],
        controller: '수현',
      },
      leaderboard: [
        { name: '민준', points: 420, studyMin: 180 },
        { name: '지민', points: 340, studyMin: 132, isSelf: true },
        { name: '수현', points: 280, studyMin: 95 },
      ],
    };
  }

  function _dateKey() { return new Date().toISOString().slice(0, 10); }

  function load(userName) {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return _defaultState(userName);
      const data = JSON.parse(raw);
      if (!data.daily[_dateKey()]) data.daily[_dateKey()] = _defaultState(userName).daily[_dateKey()];
      // Sync user name from auth
      if (userName) { data.user.name = userName; data.user.avatar = userName; }
      return data;
    } catch {
      return _defaultState(userName);
    }
  }

  function save(state) { localStorage.setItem(KEY, JSON.stringify(state)); }
  function reset() { localStorage.removeItem(KEY); return _defaultState(); }

  return { load, save, reset, dateKey: _dateKey };
})();

const Timer = (() => {
  let _interval = null;
  let _elapsedSec = 0;
  let _sessionStart = null;
  let _onTick = null;

  function start(onTick) {
    if (_interval) return;
    _sessionStart = Date.now();
    _elapsedSec = 0;
    _onTick = onTick;
    _interval = setInterval(() => {
      _elapsedSec = Math.floor((Date.now() - _sessionStart) / 1000);
      if (_onTick) _onTick(_elapsedSec);
    }, 1000);
  }

  function stop() {
    if (!_interval) return 0;
    clearInterval(_interval);
    _interval = null;
    const sec = _elapsedSec;
    _elapsedSec = 0;
    return sec;
  }

  function isRunning() { return _interval !== null; }
  
  function fmtOverlay(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  
  function fmtShort(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h}시간 ${m}분`;
    return `${m}분`;
  }

  return { start, stop, isRunning, fmtOverlay, fmtShort };
})();

const UI = (() => {
  const $ = (id) => document.getElementById(id);
  
  function renderStudyCard(state, sessionSec = 0) {
    const today = state.daily[Storage.dateKey()];
    const totalSec = today.studySec + sessionSec;
    const pct = Math.min(100, Math.round((totalSec / state.goal) * 100));
    
    if ($('study-time-display')) $('study-time-display').textContent = Timer.fmtShort(totalSec);
    if ($('study-goal-label')) $('study-goal-label').textContent = `목표 ${Timer.fmtShort(state.goal)} · ${pct}%`;
    if ($('study-progress-fill')) $('study-progress-fill').style.width = pct + '%';
    if ($('points-display')) $('points-display').textContent = state.points.toLocaleString() + ' pt';
  }

  function renderGroupRoom(state, sessionSec = 0) {
    const container = $('participant-grid');
    if (!container) return;

    container.innerHTML = state.group.members.map(m => {
      const isMe = m.isSelf;
      const timeStr = isMe ? Timer.fmtOverlay(sessionSec) : (m.studyMin ? `${m.studyMin}m` : '집중 중');
      return `
        <div class="p-card ${isMe ? 'active' : ''}">
          <div class="p-avatar">👤</div>
          <div class="p-name">${m.name}${isMe ? ' (나)' : ''}</div>
          <div class="p-time" style="color: ${isMe ? '#fff' : '#888'}">${timeStr}</div>
        </div>
      `;
    }).join('');
  }

  function renderLimits(state) {
    const limits = state.daily[Storage.dateKey()].appLimits;
    let totalRemain = 0;
    
    const html = Object.entries(limits).map(([name, cat]) => {
      const remain = Math.max(0, cat.limitSec - cat.usedSec);
      totalRemain += remain;
      const pct = Math.min(100, (cat.usedSec / cat.limitSec) * 100);
      
      return `
        <div class="list-item">
          <div style="font-size:0.9rem;">${cat.icon} ${name}</div>
          <div style="display:flex; align-items:center; gap:10px; width:60%; justify-content:flex-end;">
            <span style="font-size:0.8rem; color:var(--text-sub);">${Timer.fmtShort(remain)} 남음</span>
            <div style="width:50px; height:4px; background:#333; border-radius:2px;">
              <div style="width:${pct}%; height:100%; background:#fff; border-radius:2px;"></div>
            </div>
          </div>
        </div>`;
    }).join('');

    if ($('limits-list')) $('limits-list').innerHTML = html;
    if ($('limits-list-stats')) $('limits-list-stats').innerHTML = html;
    if ($('remain-app-time')) $('remain-app-time').textContent = Timer.fmtShort(totalRemain);
  }

  function renderLeaderboard(state) {
    const list = $('leaderboard-list');
    if (!list) return;
    const sorted = [...state.leaderboard].sort((a, b) => b.points - a.points);
    const rank = sorted.findIndex(m => m.isSelf) + 1;
    if ($('my-rank')) $('my-rank').textContent = `#${rank}`;
    
    list.innerHTML = sorted.map((m, i) => `
      <div class="list-item" style="${m.isSelf ? 'border: 1px solid #fff;' : ''}">
        <div style="font-size:0.9rem;"><strong>${i+1}</strong>. ${m.name}</div>
        <div style="font-weight:600;">${m.points} pt</div>
      </div>
    `).join('');
  }

  function renderStats(state) {
    if ($('total-study-min')) $('total-study-min').textContent = Math.floor(state.daily[Storage.dateKey()].studySec / 60);
    if ($('streak-big')) $('streak-big').textContent = state.streak + '일';
    if ($('group-name')) $('group-name').textContent = state.group.name;
    if ($('group-controller')) $('group-controller').textContent = state.group.controller + ' 리더';
    if ($('group-avatars')) $('group-avatars').innerHTML = state.group.members.map(m => `<span>👤</span>`).join('');
  }

  function showTab(tabId) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    if ($(tabId + '-panel')) $(tabId + '-panel').classList.add('active');
    const navBtn = document.querySelector(`[data-tab="${tabId}"]`);
    if (navBtn) navBtn.classList.add('active');
  }

  return { 
    renderStudyCard, renderGroupRoom, renderLimits, 
    renderLeaderboard, renderStats, showTab, $ 
  };
})();

const App = (() => {
  let state = null;

  function init() {
    // 로그인 체크
    if (!Auth.isLoggedIn()) {
      _showLoginScreen();
      _bindLoginEvents();
      return;
    }
    _launchApp();
  }

  function _showLoginScreen() {
    const screen = UI.$('login-screen');
    if (screen) screen.classList.remove('hidden');
  }

  function _hideLoginScreen() {
    const screen = UI.$('login-screen');
    if (screen) screen.classList.add('hidden');
  }

  function _bindLoginEvents() {
    // Google GSI가 호출하는 전역 콜백
    window.handleGoogleLogin = function(response) {
      if (!response || !response.credential) return;
      const user = Auth.loginWithCredential(response.credential);
      if (!user) return;
      _hideLoginScreen();
      _launchApp();
    };
  }

  function _launchApp() {
    const authUser = Auth.getUser();
    const userName = authUser ? authUser.name : null;
    state = Storage.load(userName);

    // 인사 텍스트 동기화
    const greetingName = document.querySelector('.greeting-name');
    if (greetingName) greetingName.textContent = `안녕, ${state.user.name}`;
    const userAvatar = UI.$('user-avatar');
    if (userAvatar) userAvatar.textContent = state.user.name.slice(0, 2);

    renderAll();
    _bindEvents();

    setInterval(() => {
      const now = new Date();
      const clock = UI.$('clock');
      if (clock) clock.textContent = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    }, 1000);
  }

  function renderAll(sessionSec = 0) {
    UI.renderStudyCard(state, sessionSec);
    UI.renderGroupRoom(state, sessionSec);
    UI.renderLimits(state);
    UI.renderLeaderboard(state);
    UI.renderStats(state);
  }

  function _bindEvents() {
    const studyBtn = UI.$('study-btn');
    if (studyBtn) studyBtn.addEventListener('click', _startStudy);

    const stopBtn = UI.$('overlay-stop-btn');
    if (stopBtn) stopBtn.addEventListener('click', _stopStudy); // [수정] confirm 창 없이 바로 정지

    document.querySelectorAll('[data-tab]').forEach(el => {
      el.addEventListener('click', () => UI.showTab(el.dataset.tab));
    });

    const resetBtn = UI.$('reset-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        Storage.reset();
        state = Storage.load(Auth.getUser()?.name);
        renderAll();
      });
    }

    const logoutBtn = UI.$('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        Timer.stop();
        const overlay = UI.$('timer-overlay');
        if (overlay) overlay.style.display = 'none';
        Auth.logout();
        _showLoginScreen();
        _bindLoginEvents();
        // GSI 버튼 재렌더링
        if (window.google && google.accounts && google.accounts.id) {
          google.accounts.id.renderButton(
            document.querySelector('.g_id_signin'),
            { type: 'standard', size: 'large', theme: 'outline', text: 'signin_with', shape: 'rectangular', logo_alignment: 'left', width: 280 }
          );
        }
      });
    }
  }

  function _startStudy() {
    const overlay = UI.$('timer-overlay');
    if (overlay) overlay.style.display = 'flex';

    Timer.start((sec) => {
      const el = UI.$('session-elapsed');
      if (el) el.textContent = Timer.fmtOverlay(sec);
      UI.renderStudyCard(state, sec);
      UI.renderGroupRoom(state, sec);
    });
  }

  function _stopStudy() {
    const sec = Timer.stop();
    const overlay = UI.$('timer-overlay');
    if (overlay) overlay.style.display = 'none';

    // 공부한 시간 저장
    const today = state.daily[Storage.dateKey()];
    today.studySec += sec;
    
    // 1분당 2포인트 적립 로직
    if (sec >= 60) {
      state.points += Math.floor(sec / 60) * 2;
    }
    
    Storage.save(state);
    renderAll();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => App.init());