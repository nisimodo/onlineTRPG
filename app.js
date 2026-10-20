(() => {
  'use strict';

  const CFG = window.TRPG_CONFIG || {};
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname) || location.protocol === 'file:';
  // 手元（localhost）で開いたときは手元のサーバーにつなぐ
  const API = (isLocal ? 'http://127.0.0.1:8787' : CFG.WORKER_URL || '').replace(/\/$/, '');
  const WS_URL = API.replace(/^http/, 'ws') + '/api/ws';

  const ICONS = ['⚔️', '🛡️', '🏹', '🔮', '🐉', '🦉', '🌙', '⭐', '🔥', '🍀'];
  const ICON_NAMES = ['剣', '盾', '弓', '水晶', '竜', '梟', '月', '星', '炎', '若葉'];
  const ICON_COLORS = ['#b03a2e', '#2e6da4', '#2f7a46', '#7d3c98', '#c0571b', '#6e6259', '#2c3e70', '#b7950b', '#d1453b', '#138d75'];
  const PHASE_LABEL = {
    lobby: 'キャラ選択中',
    actions: '行動宣言',
    rolls: '判定中',
    gm: 'GM思考中',
    ended: '終了',
    error: '停止中',
  };

  // ---------- 小物 ----------
  const store = {
    get(k) {
      try {
        return JSON.parse(localStorage.getItem(k));
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch {}
    },
  };

  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'style') node.style.cssText = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function iconBadge(i, small) {
    return el('span', {
      class: 'icon-badge' + (small ? ' sm' : ''),
      style: `--c:${ICON_COLORS[i] || '#888'}`,
      title: ICON_NAMES[i] || '',
      text: ICONS[i] || '?',
    });
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  function openModal(...content) {
    const box = $('#modal-content');
    box.replaceChildren(...content);
    $('#modal').hidden = false;
  }
  function closeModal() {
    $('#modal').hidden = true;
  }
  document.querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', closeModal));

  function show(screen) {
    for (const id of ['gate', 'lobby', 'game']) $('#screen-' + id).hidden = id !== screen;
  }

  // ---------- 状態 ----------
  const S = {
    sitePass: store.get('trpg.sitePass'),
    scenarios: [],
    rooms: [],
    maxRooms: 3,
    selectedScenario: null,
    ws: null,
    you: null,
    room: null,
    scenario: null,
    logs: [],
    session: store.get('trpg.session'),
    welcomed: false,
    closing: false,
    retry: 0,
    retryTimer: null,
    pingTimer: null,
    inputMode: 'action',
    tab: 'story',
    drafts: { action: '', chat: '' },
    lobbyTimer: null,
  };

  // ---------- HTTP ----------
  async function api(path, opts = {}) {
    if (!API) throw new Error('config.js に WORKER_URL が設定されていません');
    const res = await fetch(API + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'X-Site-Pass': S.sitePass || '', ...(opts.headers || {}) },
    });
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (res.status === 401) {
      S.sitePass = null;
      store.del('trpg.sitePass');
      goGate(data.error || '合言葉が違います');
      throw new Error(data.error || 'unauthorized');
    }
    if (!res.ok) throw new Error(data.error || `通信エラー (${res.status})`);
    return data;
  }

  // ---------- 合言葉 ----------
  function goGate(err) {
    stopLobbyTimer();
    show('gate');
    const e = $('#gate-error');
    e.hidden = !err;
    e.textContent = err || '';
    $('#gate-pass').focus();
  }

  $('#gate-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    S.sitePass = $('#gate-pass').value.trim();
    try {
      await api('/api/auth');
      store.set('trpg.sitePass', S.sitePass);
      $('#gate-pass').value = '';
      goLobby();
    } catch (e) {
      if (e.message !== 'unauthorized') goGate(e.message);
    }
  });

  $('#logout').addEventListener('click', () => {
    S.sitePass = null;
    store.del('trpg.sitePass');
    goGate();
  });

  // ---------- ロビー ----------
  function stopLobbyTimer() {
    clearInterval(S.lobbyTimer);
    S.lobbyTimer = null;
  }

  async function goLobby() {
    show('lobby');
    try {
      if (!S.scenarios.length) {
        const d = await api('/api/scenarios');
        S.scenarios = d.scenarios;
        renderScenarioList();
      }
      await refreshRooms();
    } catch (e) {
      if (e.message !== 'unauthorized') toast(e.message);
      return;
    }
    stopLobbyTimer();
    S.lobbyTimer = setInterval(() => {
      if (!$('#screen-lobby').hidden && document.visibilityState === 'visible') refreshRooms().catch(() => {});
    }, 8000);
  }

  async function refreshRooms() {
    const d = await api('/api/rooms');
    S.rooms = d.rooms;
    S.maxRooms = d.maxRooms;
    renderRooms();
  }
  $('#rooms-refresh').addEventListener('click', () => refreshRooms().catch((e) => toast(e.message)));

  function renderRooms() {
    const list = $('#room-list');
    if (!S.rooms.length) {
      list.replaceChildren(el('div', { class: 'room-empty', text: 'まだ卓はありません。右（下）から立ててみましょう。' }));
    } else {
      list.replaceChildren(
        ...S.rooms.map((r) =>
          el(
            'div',
            { class: 'room-card' },
            el(
              'div',
              null,
              el('div', { class: 'name', text: r.name }),
              el('div', { class: 'muted', text: `${r.scenarioTitle}　／　${PHASE_LABEL[r.phase] || r.phase}` }),
              el('div', { class: 'muted', text: `参加 ${r.playerCount}/${r.maxPlayers}人（接続中 ${r.onlineCount}人）` })
            ),
            el('button', {
              class: 'btn btn-gold btn-sm',
              type: 'button',
              text: '入室',
              disabled: r.playerCount >= r.maxPlayers && !(S.session && S.session.roomId === r.id),
              onclick: () => openJoin(r),
            })
          )
        )
      );
    }
    const full = S.rooms.length >= S.maxRooms;
    const btn = $('#create-form button[type=submit]');
    btn.disabled = full;
    btn.textContent = full ? `卓は最大${S.maxRooms}つまでです` : '卓を立てる';
  }

  function renderScenarioList() {
    const box = $('#scenario-list');
    box.replaceChildren(
      ...S.scenarios.map((s) => {
        const opt = el(
          'label',
          { class: 'scenario-opt' + (S.selectedScenario === s.id ? ' selected' : '') },
          el('input', { type: 'radio', name: 'scenario', value: s.id }),
          el('div', null, el('span', { class: 's-title', text: s.title }), el('span', { class: 's-genre', text: s.genre })),
          el('div', { class: 's-sum', text: s.summary }),
          el('div', { class: 's-meta', text: `🎲 ${s.diceLabel}　👥 ${s.players}　⏳ ${s.time}` })
        );
        opt.addEventListener('click', () => {
          S.selectedScenario = s.id;
          box.querySelectorAll('.scenario-opt').forEach((n) => n.classList.remove('selected'));
          opt.classList.add('selected');
        });
        return opt;
      })
    );
  }

  $('#create-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#create-error');
    err.hidden = true;
    const name = $('#create-name').value.trim();
    const pass = $('#create-pass').value.trim();
    if (!S.selectedScenario) {
      err.textContent = 'シナリオを選んでください';
      err.hidden = false;
      return;
    }
    try {
      const d = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name, pass, scenarioId: S.selectedScenario }) });
      await refreshRooms();
      const room = S.rooms.find((r) => r.id === d.roomId) || { id: d.roomId, name, usedIcons: [] };
      openJoin(room, pass);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  });

  // ---------- 入室 ----------
  function openJoin(room, presetPass) {
    // 以前この部屋に入っていたなら、そのまま再入室
    if (S.session && S.session.roomId === room.id) {
      connect(S.session);
      return;
    }
    let icon = null;
    const used = new Set(room.usedIcons || []);
    const nameInput = el('input', { maxlength: '16', value: store.get('trpg.name') || '', placeholder: '例：たろう' });
    const passInput = el('input', { type: 'password', maxlength: '50', value: presetPass || '', placeholder: '卓を立てた人に聞いてください' });
    const errBox = el('p', { class: 'error', hidden: true });
    const pick = el(
      'div',
      { class: 'icon-pick' },
      ICONS.map((ic, i) => {
        const b = el('button', { type: 'button', disabled: used.has(i), title: ICON_NAMES[i] }, iconBadge(i), ICON_NAMES[i]);
        b.addEventListener('click', () => {
          icon = i;
          pick.querySelectorAll('button').forEach((n) => n.classList.remove('selected'));
          b.classList.add('selected');
        });
        return b;
      })
    );
    const preferred = store.get('trpg.icon');
    if (Number.isInteger(preferred) && !used.has(preferred)) {
      icon = preferred;
      pick.children[preferred].classList.add('selected');
    }
    const submit = el('button', { class: 'btn btn-gold btn-block', type: 'submit', text: '入室する' });
    const form = el(
      'form',
      { class: 'stack' },
      el('h2', { text: `「${room.name}」に入室` }),
      el('label', { class: 'field' }, el('span', { text: 'あなたの名前' }), nameInput),
      el('div', { class: 'field' }, el('span', { text: 'アイコン' }), pick),
      el('label', { class: 'field' }, el('span', { text: '卓の合言葉' }), passInput),
      submit,
      errBox
    );
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return showErr('名前を入力してください');
      if (icon == null) return showErr('アイコンを選んでください');
      if (!passInput.value.trim()) return showErr('卓の合言葉を入力してください');
      store.set('trpg.name', name);
      store.set('trpg.icon', icon);
      submit.disabled = true;
      S.joinError = (msg) => {
        submit.disabled = false;
        showErr(msg);
      };
      connect({ roomId: room.id, roomPass: passInput.value.trim(), name, icon, token: null });
    });
    function showErr(m) {
      errBox.textContent = m;
      errBox.hidden = false;
    }
    openModal(form);
    if (!nameInput.value) nameInput.focus();
  }

  // ---------- WebSocket ----------
  function connect(info) {
    clearTimeout(S.retryTimer);
    if (S.ws) {
      S.closing = true;
      try {
        S.ws.close();
      } catch {}
    }
    S.closing = false;
    S.pending = info;
    const ws = new WebSocket(WS_URL);
    S.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'join',
          sitePass: S.sitePass,
          roomId: info.roomId,
          roomPass: info.roomPass,
          name: info.name,
          icon: info.icon,
          token: info.token,
        })
      );
      clearInterval(S.pingTimer);
      S.pingTimer = setInterval(() => send({ type: 'ping' }), 25000);
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      onMessage(msg, info);
    });
    ws.addEventListener('close', () => {
      if (S.ws !== ws) return;
      clearInterval(S.pingTimer);
      if (S.closing || !S.welcomed) {
        if (!S.welcomed && !S.closing && S.joinError) S.joinError('サーバーに接続できませんでした');
        return;
      }
      $('#reconnect-bar').hidden = false;
      const delay = Math.min(1000 * 2 ** S.retry, 15000);
      S.retry++;
      S.retryTimer = setTimeout(() => connect(S.session), delay);
    });
  }

  function send(msg) {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) {
      S.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  function sendOrWarn(msg) {
    if (!send(msg)) toast('接続中です。少し待ってからもう一度どうぞ');
  }

  function leaveToLobby(message) {
    S.closing = true;
    S.welcomed = false;
    clearInterval(S.pingTimer);
    clearTimeout(S.retryTimer);
    try {
      S.ws && S.ws.close();
    } catch {}
    S.ws = null;
    S.session = null;
    store.del('trpg.session');
    S.room = null;
    document.title = 'AI卓 ― 物語の酒場';
    if (message) toast(message);
    goLobby();
  }

  function onMessage(msg, info) {
    switch (msg.type) {
      case 'joinError':
        S.closing = true;
        try {
          S.ws.close();
        } catch {}
        if (S.welcomed || (S.session && info === S.session && !S.joinError)) {
          // 再接続に失敗（部屋が消えた等）
          leaveToLobby(msg.message);
        } else if (S.joinError) {
          S.joinError(msg.message);
        } else {
          leaveToLobby(msg.message);
        }
        return;
      case 'welcome':
        S.welcomed = true;
        S.retry = 0;
        S.joinError = null;
        $('#reconnect-bar').hidden = true;
        S.you = msg.you;
        S.room = msg.room;
        S.scenario = msg.scenario;
        S.logs = msg.logs || [];
        S.session = { roomId: msg.room.id, roomPass: info.roomPass, token: msg.token, name: info.name, icon: info.icon };
        store.set('trpg.session', S.session);
        closeModal();
        stopLobbyTimer();
        show('game');
        renderAllLogs();
        renderGame();
        return;
      case 'state':
        S.room = msg.room;
        renderGame();
        return;
      case 'log':
        S.logs.push(msg.entry);
        appendLog(msg.entry);
        if (S.tab !== 'story') $('#tabs [data-tab=story]').classList.add('badge');
        return;
      case 'error':
        toast(msg.message);
        return;
      case 'closed':
        leaveToLobby(msg.message);
        return;
      case 'left':
        leaveToLobby('退室しました');
        return;
    }
  }

  document.addEventListener('visibilitychange', () => {
    // スマホでアプリを切り替えて戻ってきたら、すぐ再接続
    if (document.visibilityState === 'visible' && S.session && S.welcomed && (!S.ws || S.ws.readyState > 1)) {
      S.retry = 0;
      connect(S.session);
    }
  });

  // ---------- ゲーム画面 ----------
  function me() {
    return S.room?.players.find((p) => p.pid === S.you);
  }
  function playerOf(pid) {
    return S.room?.players.find((p) => p.pid === pid);
  }
  function isHost() {
    return S.room?.hostPid === S.you;
  }

  function myTurnNeeded() {
    const r = S.room;
    const m = me();
    if (!r || !m || !m.sheet || m.dead) return false;
    if (r.phase === 'actions') return !m.acted;
    if (r.phase === 'rolls') return r.pendingRolls.some((q) => q.pid === S.you && !q.result);
    return false;
  }

  function renderGame() {
    const r = S.room;
    if (!r) return;
    $('#g-room').textContent = r.name;
    $('#g-scenario').textContent = r.scenarioTitle;
    $('#g-scene').textContent = r.scene;
    const badge = $('#g-phase');
    const mine = myTurnNeeded();
    badge.textContent = me()?.dead && r.phase !== 'ended' ? '💀 観戦中' : mine ? (r.phase === 'rolls' ? 'あなたの判定！' : 'あなたの番') : PHASE_LABEL[r.phase] || r.phase;
    badge.classList.toggle('me', mine);
    document.title = (mine ? '【あなたの番】' : '') + r.name + ' ― 物語の酒場';

    const needChar = r.phase === 'lobby' || !me()?.sheet;
    $('#charselect').hidden = !needChar;
    $('#log').hidden = needChar && r.phase === 'lobby';
    if (needChar) renderCharSelect();
    renderControls();
    renderParty();
    renderSheet();
    renderDice();
  }

  // キャラ選択
  function renderCharSelect() {
    const r = S.room;
    const m = me();
    const takenBy = new Map(r.players.filter((p) => p.charIndex != null).map((p) => [p.charIndex, p]));
    const ready = r.players.filter((p) => p.sheet);
    const head = el(
      'div',
      { class: 'cs-head' },
      el(
        'div',
        null,
        el('h2', { text: r.phase === 'lobby' ? 'キャラクターを選んでください' : '途中参加：キャラクターを選んでください' }),
        el('p', { class: 'muted', text: `🎲 ${S.scenario.diceLabel}　—　${S.scenario.summary}` }),
        el(
          'div',
          { class: 'ready-list' },
          r.players.map((p) =>
            el('span', { class: 'acted-chip' + (p.sheet ? ' done' : '') }, iconBadge(p.icon, true), p.name)
          )
        )
      ),
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'ルール', onclick: showRules }),
        r.phase === 'lobby' && isHost()
          ? el('button', {
              class: 'btn btn-gold',
              type: 'button',
              text: `冒険を始める（${ready.length}人）`,
              disabled: ready.length === 0,
              onclick: () => {
                const notReady = r.players.filter((p) => !p.sheet).length;
                if (notReady && !confirm(`まだ${notReady}人がキャラを選んでいません。始めますか？（後から途中参加できます）`)) return;
                sendOrWarn({ type: 'start' });
              },
            })
          : r.phase === 'lobby'
            ? el('span', { class: 'muted', text: m?.sheet ? 'ホストの開始を待っています…' : '' })
            : null
      )
    );
    const grid = el(
      'div',
      { class: 'char-grid' },
      S.scenario.characters.map((ch) => {
        const owner = takenBy.get(ch.index);
        const isMine = owner && owner.pid === S.you;
        const top = [...ch.skills].sort((a, b) => b.value - a.value).slice(0, 4);
        const card = el(
          'button',
          {
            type: 'button',
            class: 'char-card' + (isMine ? ' mine' : ''),
            disabled: !!owner && !isMine,
          },
          owner ? el('span', { class: 'taken' }, iconBadge(owner.icon, true)) : null,
          el('div', { class: 'cc-name', text: ch.name }),
          el('div', { class: 'cc-role', text: ch.role }),
          el('div', { class: 'cc-desc', text: ch.desc }),
          el('div', { class: 'cc-res' }, ch.resources.map((x) => el('span', { text: `${x.name} ${x.max}` }))),
          el('div', { class: 'cc-top' }, top.map((s) => el('span', { text: `${s.name} ${s.value}` })))
        );
        card.addEventListener('click', () => showCharDetail(ch, owner, isMine));
        return card;
      })
    );
    const box = $('#charselect');
    const top = box.scrollTop;
    box.replaceChildren(head, grid);
    box.scrollTop = top;
  }

  function skillGrid(skills) {
    const max = Math.max(...skills.map((s) => s.value));
    const vals = skills.map((s) => s.value).sort((a, b) => b - a);
    const hiLine = vals[Math.min(4, vals.length - 1)];
    return el(
      'div',
      { class: 'skill-grid' },
      skills.map((s) =>
        el('div', { class: s.value >= hiLine && s.value > 0 && max > 0 ? 'hi' : '' }, el('span', { text: s.name }), el('b', { text: s.value }))
      )
    );
  }

  function showCharDetail(ch, owner, isMine) {
    const canPick = !owner && (S.room.phase === 'lobby' || !me()?.sheet);
    openModal(
      el('div', { class: 'sheet-name', text: ch.name }),
      el('div', { class: 'sheet-role', text: ch.role }),
      el('p', { class: 'sheet-desc', text: ch.desc }),
      el('h3', { text: 'ステータス' }),
      el('div', { class: 'cc-res', style: 'display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap' }, ch.resources.map((x) => el('b', { text: `${x.name} ${x.value}/${x.max}` }))),
      el('h3', { text: '技能' }),
      skillGrid(ch.skills),
      el('div', { style: 'height:16px' }),
      isMine
        ? el('p', { class: 'muted', text: 'あなたが選んでいるキャラクターです' })
        : canPick
          ? el('button', {
              class: 'btn btn-gold btn-block',
              type: 'button',
              text: 'このキャラクターにする',
              onclick: () => {
                sendOrWarn({ type: 'pickChar', index: ch.index });
                closeModal();
              },
            })
          : el('p', { class: 'muted', text: owner ? `${owner.name} さんが選んでいます` : '' })
    );
  }

  // 操作エリア
  // 入力欄は、作り直すとスマホのキーボードが閉じてしまうので、必要なときだけ作り直す
  const ctrl = { card: null, modeBox: null, inputSlot: null, infoSlot: null, inputKey: null };

  function renderControls() {
    const r = S.room;
    const m = me();
    const box = $('#controls');
    if (r.phase === 'lobby' || !m?.sheet) {
      box.replaceChildren();
      ctrl.card = null;
      ctrl.inputKey = null;
      return;
    }
    if (!ctrl.card) {
      ctrl.modeBox = el('div', { class: 'mode-switch' });
      ctrl.inputSlot = el('div');
      ctrl.infoSlot = el('div');
      ctrl.card = el('div', { class: 'ctrl-card parchment' }, ctrl.modeBox, ctrl.inputSlot, ctrl.infoSlot);
      box.replaceChildren(ctrl.card);
    }
    if (m.dead) S.inputMode = 'chat';
    ctrl.modeBox.replaceChildren(
      ...(m.dead
        ? [el('button', { type: 'button', class: 'on', text: '雑談のみ' })]
        : [
            el('button', { type: 'button', class: S.inputMode === 'action' ? 'on' : '', text: '行動', onclick: () => setMode('action') }),
            el('button', { type: 'button', class: S.inputMode === 'chat' ? 'on' : '', text: '雑談', onclick: () => setMode('chat') }),
          ])
    );

    const inputKey = `${S.inputMode}|${S.inputMode === 'chat' ? '' : r.phase}|${m.acted}|${m.dead}`;
    if (inputKey !== ctrl.inputKey) {
      ctrl.inputKey = inputKey;
      const parts = [];
      if (m.dead) {
        parts.push(el('div', { class: 'dead-note', text: `💀 ${m.sheet.name} は${m.sheet.condition === '死亡' ? '力尽きました' : '物語から退場しました'}。ここからは観戦と雑談だけできます。` }));
      }
      if (S.inputMode === 'chat') {
        parts.push(inputRow('仲間と相談・雑談（GMには届きません）', '送る', (text) => sendOrWarn({ type: 'chat', text })));
      } else if (r.phase === 'actions') {
        parts.push(
          m.acted
            ? el(
                'div',
                { class: 'my-action' },
                '✓ 行動を宣言しました。全員の宣言がそろうとGMが語ります。',
                el('div', { style: 'margin-top:6px' }, el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '宣言を取り消す', onclick: () => sendOrWarn({ type: 'cancelAction' }) }))
              )
            : inputRow(`${m.sheet.name} はどうする？（例：扉を調べる、NPCに話しかける）`, '宣言', (text) => sendOrWarn({ type: 'action', text }))
        );
      }
      ctrl.inputSlot.replaceChildren(...parts);
    }

    const card = el('div');
    if (S.inputMode === 'chat') {
      card.append(el('p', { class: 'muted', style: 'margin:6px 0 0', text: m.dead ? `いま：${PHASE_LABEL[r.phase] || r.phase}` : `いま：${PHASE_LABEL[r.phase] || r.phase}（「行動」に切り替えて進行できます）` }));
    } else if (r.phase === 'actions') {
      card.append(waitLine(r.players.filter((p) => p.sheet && !p.dead), (p) => p.acted));
      if (isHost()) {
        card.append(
          el('div', { style: 'margin-top:8px' }, el('button', {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            text: '⏩ 待たずに進める（ホスト）',
            onclick: () => confirm('まだ宣言していない人を待たずに、GMに進めてもらいますか？') && sendOrWarn({ type: 'force' }),
          }))
        );
      }
    } else if (r.phase === 'rolls') {
      card.append(el('h3', { text: '🎲 GMが判定を求めています' }));
      for (const q of r.pendingRolls) {
        const owner = playerOf(q.pid);
        const mine = q.pid === S.you;
        const canProxy = isHost() && owner && !owner.connected;
        const target = q.target != null ? (q.mode === 'le' ? `目標 ${q.target} 以下` : q.mode === 'ge' ? `目標 ${q.target} 以上` : q.mode === 'count' ? `${q.target}以上の数` : '') : '';
        card.append(
          el(
            'div',
            { class: 'roll-req' + (mine && !q.result ? ' mine' : '') },
            el(
              'div',
              { class: 'rq-text' },
              owner ? iconBadge(owner.icon, true) : null,
              ' ',
              el('b', { text: `${owner?.sheet?.name || owner?.name || '?'}：${q.skill}` }),
              el('div', { class: 'muted', text: `${q.reason}　${q.dice}　${target}` })
            ),
            q.result
              ? resultBadge(q.result)
              : mine || canProxy
                ? el('button', { class: 'btn btn-gold btn-sm', type: 'button', text: mine ? 'ダイスを振る' : '代わりに振る', onclick: (e) => { e.currentTarget.disabled = true; sendOrWarn({ type: 'roll', rollId: q.id }); } })
                : el('span', { class: 'muted', text: '待機中…' })
          )
        );
      }
      if (isHost()) {
        card.append(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '⏩ 残りを自動で振る（ホスト）', onclick: () => sendOrWarn({ type: 'force' }) }));
      }
    } else if (r.phase === 'gm') {
      card.append(el('div', { class: 'thinking' }, el('span', { class: 'quill', text: '🪶' }), 'GMが物語を紡いでいます…'));
      if (isHost()) {
        card.append(el('div', { style: 'margin-top:8px' }, el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '応答が来ない時：中断する', onclick: () => confirm('GMの応答を中断して、再試行できる状態にしますか？') && sendOrWarn({ type: 'force' }) })));
      }
    } else if (r.phase === 'error') {
      card.append(
        el('p', { class: 'error', text: '⚠ ' + (r.lastError || 'エラーが発生しました') }),
        el('button', { class: 'btn btn-gold', type: 'button', text: 'もう一度GMに頼む', onclick: () => sendOrWarn({ type: 'retry' }) })
      );
    } else if (r.phase === 'ended') {
      card.append(
        el('h3', { text: '🏁 セッションは終了しました。お疲れさまでした！' }),
        el('div', { class: 'row' },
          el('button', { class: 'btn btn-ghost', type: 'button', text: '退室する', onclick: () => sendOrWarn({ type: 'leave' }) }),
          isHost() ? el('button', { class: 'btn btn-danger', type: 'button', text: '卓を解散する', onclick: () => confirm('卓を解散しますか？ログも消えます。') && sendOrWarn({ type: 'closeRoom' }) }) : null
        )
      );
    }
    ctrl.infoSlot.replaceChildren(...card.childNodes);
  }

  function setMode(mode) {
    S.inputMode = mode;
    renderControls();
    const ta = $('#controls textarea');
    if (ta) ta.focus();
  }

  function inputRow(placeholder, label, onSend) {
    const mode = S.inputMode;
    const ta = el('textarea', { placeholder, maxlength: '600', rows: '2' });
    ta.value = S.drafts[mode] || '';
    ta.addEventListener('input', () => (S.drafts[mode] = ta.value));
    const go = () => {
      const text = ta.value.trim();
      if (!text) return;
      onSend(text);
      S.drafts[mode] = '';
      ta.value = '';
    };
    ta.addEventListener('keydown', (e) => {
      // PCは Ctrl/⌘+Enter で送信
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        go();
      }
    });
    return el('div', { class: 'input-row' }, ta, el('button', { class: 'btn btn-gold', type: 'button', text: label, onclick: go }));
  }

  function waitLine(players, isDone) {
    const done = players.filter(isDone).length;
    return el(
      'div',
      { class: 'wait-line' },
      el('span', { class: 'muted', text: `宣言 ${done}/${players.length}` }),
      players.map((p) => el('span', { class: 'acted-chip' + (isDone(p) ? ' done' : ''), title: p.connected ? '' : '接続が切れています' }, iconBadge(p.icon, true), p.name + (p.connected ? '' : '（離席）')))
    );
  }

  function resultBadge(r) {
    if (r.critical) return el('span', { class: 'res crit', text: 'クリティカル' });
    if (r.fumble) return el('span', { class: 'res fum', text: 'ファンブル' });
    if (r.success === true) return el('span', { class: 'res ok', text: r.mode === 'count' ? `成功 ×${r.successes}` : '成功' });
    if (r.success === false) return el('span', { class: 'res ng', text: '失敗' });
    return el('span', { class: 'roll-total', text: `= ${r.total}` });
  }

  // 仲間
  function renderParty() {
    const r = S.room;
    const sec = $('#sec-party');
    sec.replaceChildren(
      el('h2', { text: `👥 仲間（${r.players.length}/10）` }),
      el(
        'div',
        { class: 'party-list' },
        r.players.map((p) => {
          const hp = p.sheet?.resources[0];
          return el(
            'button',
            { class: 'party-item' + (p.dead ? ' dead' : ''), type: 'button', onclick: () => p.sheet && showPlayerSheet(p) },
            iconBadge(p.icon),
            el(
              'div',
              { class: 'pi-main' },
              el('div', { class: 'pi-name' }, el('span', { class: 'dot' + (p.connected ? ' on' : '') }), (r.hostPid === p.pid ? '👑 ' : '') + p.name + (p.pid === S.you ? '（あなた）' : '')),
              el('div', { class: 'pi-char', text: p.sheet ? `${p.sheet.name}（${p.sheet.role}）${p.sheet.condition && p.sheet.condition !== '良好' ? '／' + p.sheet.condition : ''}` : 'キャラ未選択' }),
              hp ? el('div', { class: 'bar', title: `${hp.name} ${hp.value}/${hp.max}` }, el('i', { style: `width:${Math.max(0, Math.min(100, (hp.value / hp.max) * 100))}%` })) : null
            ),
            p.dead ? el('span', { text: '💀', title: '退場' }) : r.phase === 'actions' && p.sheet ? el('span', { text: p.acted ? '✓' : '…', title: p.acted ? '宣言済み' : '考え中' }) : null
          );
        })
      )
    );
  }

  function sheetView(sheet, player) {
    const ch = S.scenario.characters.find((c) => c.name === sheet.name);
    return [
      el('div', { class: 'sheet-head' }, player ? iconBadge(player.icon) : null, el('div', null, el('div', { class: 'sheet-name', text: sheet.name }), el('div', { class: 'sheet-role', text: sheet.role }))),
      ch ? el('p', { class: 'sheet-desc', text: ch.desc }) : null,
      player?.dead ? el('div', { class: 'dead-note', text: '💀 このキャラクターは退場しました' }) : null,
      el('div', { class: 'cond' }, '状態：', el('b', { text: sheet.condition || '良好' })),
      el(
        'div',
        { class: 'res-list' },
        sheet.resources.map((x) =>
          el(
            'div',
            { class: 'res-item' },
            el('div', { class: 'res-top' }, el('span', { text: x.name }), el('span', { text: `${x.value} / ${x.max}` })),
            el('div', { class: 'bar' }, el('i', { style: `width:${x.max ? Math.max(0, Math.min(100, (x.value / x.max) * 100)) : 0}%` }))
          )
        )
      ),
      el('h3', { text: '技能' }),
      skillGrid(sheet.skills),
    ].filter(Boolean);
  }

  function showPlayerSheet(p) {
    openModal(el('p', { class: 'muted', text: `プレイヤー：${p.name}` }), ...sheetView(p.sheet, p));
  }

  function renderSheet() {
    const m = me();
    const sec = $('#sec-sheet');
    if (!m?.sheet) {
      sec.replaceChildren(el('h2', { text: '🧙 あなたのキャラ' }), el('p', { class: 'muted', text: 'まだキャラクターを選んでいません' }));
      return;
    }
    sec.replaceChildren(el('h2', { text: '🧙 あなたのキャラ' }), ...sheetView(m.sheet, m));
  }

  // ダイス
  const dice = { sides: 6, count: 2, mod: 0 };
  function renderDice() {
    const sec = $('#sec-dice');
    if (sec.dataset.built) {
      $('#dice-hint').textContent = S.scenario ? `このシナリオ：${S.scenario.diceLabel}` : '';
      $('#free-roll').disabled = !!me()?.dead;
      return;
    }
    sec.dataset.built = '1';
    const countInput = el('input', { type: 'number', min: '1', max: '20', value: dice.count });
    const modInput = el('input', { type: 'number', min: '-99', max: '99', value: dice.mod });
    const labelInput = el('input', { maxlength: '30', placeholder: '何の判定？（任意）' });
    const sidesBox = el('div', { class: 'dice-sides' });
    const preview = el('div', { class: 'muted', style: 'margin:8px 0' });
    const update = () => {
      dice.count = Math.max(1, Math.min(20, parseInt(countInput.value, 10) || 1));
      dice.mod = Math.max(-99, Math.min(99, parseInt(modInput.value, 10) || 0));
      sidesBox.querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.s) === dice.sides));
      preview.textContent = `振るダイス：${expr()}`;
    };
    const expr = () => `${dice.count}d${dice.sides}${dice.mod > 0 ? '+' + dice.mod : dice.mod < 0 ? dice.mod : ''}`;
    for (const s of [6, 10, 100]) {
      sidesBox.append(el('button', { type: 'button', 'data-s': s, text: `${s}面`, onclick: () => { dice.sides = s; update(); } }));
    }
    const step = (input, d) => el('button', { type: 'button', text: d > 0 ? '+' : '−', onclick: () => { input.value = (parseInt(input.value, 10) || 0) + d; update(); } });
    countInput.addEventListener('input', update);
    modInput.addEventListener('input', update);
    const roll = () => {
      update();
      sendOrWarn({ type: 'freeRoll', dice: expr(), label: labelInput.value.trim() });
      labelInput.value = '';
      if (window.matchMedia('(max-width: 899px)').matches) setTab('story');
    };
    const preset = (c, s) => el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: `${c}d${s}`, onclick: () => { dice.count = c; dice.sides = s; dice.mod = 0; countInput.value = c; modInput.value = 0; update(); } });
    sec.append(
      el('h2', { text: '🎲 ダイス' }),
      el('p', { class: 'muted', id: 'dice-hint' }),
      sidesBox,
      el('div', { class: 'row', style: 'justify-content:space-between' }, el('span', { text: '個数' }), el('div', { class: 'stepper' }, step(countInput, -1), countInput, step(countInput, 1))),
      el('div', { class: 'row', style: 'justify-content:space-between;margin-top:6px' }, el('span', { text: '修正値' }), el('div', { class: 'stepper' }, step(modInput, -1), modInput, step(modInput, 1))),
      el('div', { style: 'margin-top:8px' }, labelInput),
      preview,
      el('button', { class: 'btn btn-gold btn-block', type: 'button', id: 'free-roll', text: '自由にダイスを振る', onclick: roll }),
      el('div', { class: 'dice-presets' }, preset(1, 100), preset(1, 10), preset(2, 6), preset(3, 6), preset(1, 6)),
      el('p', { class: 'muted', style: 'margin-top:10px', text: 'GMから判定を求められたときは、物語画面のボタンから振ってください。' })
    );
    update();
    $('#free-roll').disabled = !!me()?.dead;
    $('#dice-hint').textContent = S.scenario ? `このシナリオ：${S.scenario.diceLabel}` : '';
  }

  // ---------- ログ ----------
  function renderAllLogs() {
    const log = $('#log');
    log.replaceChildren(...S.logs.map(logNode).filter(Boolean));
    requestAnimationFrame(() => {
      log.style.scrollBehavior = 'auto';
      log.scrollTop = log.scrollHeight;
      log.style.scrollBehavior = '';
    });
  }

  function appendLog(entry) {
    const log = $('#log');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 160;
    const node = logNode(entry);
    if (!node) return;
    log.append(node);
    if (nearBottom || entry.pid === S.you || entry.kind === 'gm') {
      requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
    }
  }

  function who(e) {
    return el('div', { class: 'who' }, e.name || '', e.charName ? el('small', { text: `（${e.charName}）` }) : null);
  }

  function logNode(e) {
    switch (e.kind) {
      case 'gm':
        return el(
          'div',
          { class: 'entry gm' },
          e.scene ? el('div', { class: 'scene', text: `GM ◆ ${e.scene}` }) : null,
          String(e.text)
            .split(/\n+/)
            .filter((s) => s.trim())
            .map((line) => el('p', { text: line }))
        );
      case 'action':
        return el('div', { class: 'entry action' }, iconBadge(e.icon), el('div', null, who(e), el('div', { class: 'bubble', text: e.text })));
      case 'chat':
        return el('div', { class: 'entry chat' }, iconBadge(e.icon, true), el('div', null, el('div', { class: 'who' }, e.name, el('span', { class: 'tag', text: '雑談' })), el('div', { class: 'bubble', text: e.text })));
      case 'roll': {
        const r = e.result;
        const hit = (v) => (r.mode === 'count' && r.target != null && v >= r.target ? ' hit' : '');
        return el(
          'div',
          { class: 'entry roll' },
          iconBadge(e.icon),
          el(
            'div',
            { class: 'roll-box' },
            el('div', { class: 'r-head' }, `${e.charName || e.name}：${e.skill}`, e.free ? el('small', { text: '（自由ロール）' }) : null, e.proxy ? el('small', { text: `（${e.proxy}が代理）` }) : null),
            e.reason ? el('div', { style: 'font-size:.75rem;opacity:.75', text: e.reason }) : null,
            el(
              'div',
              { class: 'dice-row' },
              el('span', { style: 'font-size:.75rem;opacity:.8;margin-right:4px', text: r.dice }),
              r.rolls.map((v) => el('span', { class: 'die' + hit(v), text: v })),
              r.mode !== 'count' ? el('span', { class: 'roll-total', text: `= ${r.total}` }) : null,
              r.target != null ? el('span', { style: 'font-size:.75rem;opacity:.8', text: r.mode === 'le' ? `（${r.target}以下）` : r.mode === 'ge' ? `（${r.target}以上）` : `（${r.target}以上を数える）` }) : null,
              r.success != null ? resultBadge(r) : null
            )
          )
        );
      }
      case 'death':
        return el('div', { class: 'entry death' }, iconBadge(e.icon), el('div', { text: '💀 ' + e.text }));
      case 'status':
        return el('div', { class: 'entry status', text: '📜 ' + e.text });
      case 'system':
        return el('div', { class: 'entry system', text: '— ' + e.text + ' —' });
      default:
        return null;
    }
  }

  // ---------- メニュー・タブ ----------
  function showRules() {
    const s = S.scenario;
    openModal(
      el('h2', { text: `${s.title}` }),
      el('p', { class: 'muted', text: s.genre }),
      el('h3', { text: '判定のルール' }),
      el('p', { class: 'rules-text', text: `🎲 ${s.diceLabel}\n${s.playerRules}` }),
      el('h3', { text: 'ステータス' }),
      el('div', { class: 'rules-text', text: s.resources.map((r) => `・${r.name}：${r.desc}`).join('\n') }),
      el('h3', { text: '技能' }),
      el('div', { class: 'rules-text', text: s.skills.map((k) => `・${k.name}：${k.desc}`).join('\n') }),
      el('h3', { text: '遊び方' }),
      el('p', { class: 'rules-text', text: '1. GMの語りを読んで、「行動」欄にキャラクターの行動を書いて宣言します。\n2. 全員の宣言がそろうと、GMが結果を語ります。\n3. GMが判定を求めたら、自分の判定のボタンでダイスを振ります。\n4. 相談は「雑談」に切り替えて話せます（GMには届きません）。' })
    );
  }

  $('#g-menu').addEventListener('click', () => {
    const host = isHost();
    openModal(
      el('h2', { text: 'メニュー' }),
      el(
        'div',
        { class: 'menu-list' },
        el('button', { class: 'btn', type: 'button', text: '📖 ルールと技能の説明', onclick: showRules }),
        el('button', {
          class: 'btn',
          type: 'button',
          text: '🚪 退室する（キャラクターも手放します）',
          onclick: () => {
            if (confirm('退室しますか？ キャラクターも手放します。')) {
              closeModal();
              sendOrWarn({ type: 'leave' });
            }
          },
        }),
        el('button', {
          class: 'btn',
          type: 'button',
          text: '🏠 一時的にロビーへ戻る（あとで再入室できます）',
          onclick: () => {
            closeModal();
            const keep = S.session;
            leaveToLobby();
            S.session = keep;
            store.set('trpg.session', keep);
          },
        }),
        host
          ? el('button', {
              class: 'btn btn-danger',
              type: 'button',
              text: '💥 卓を解散する（ホスト）',
              onclick: () => {
                if (confirm('卓を解散しますか？ 全員が退出し、ログも消えます。')) {
                  closeModal();
                  sendOrWarn({ type: 'closeRoom' });
                }
              },
            })
          : null
      )
    );
  });

  function setTab(tab) {
    S.tab = tab;
    $('#game-body').dataset.tab = tab;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'story') {
      $('#tabs [data-tab=story]').classList.remove('badge');
      const log = $('#log');
      requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
    }
  }
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // ---------- 起動 ----------
  if (!API) {
    goGate('config.js に WORKER_URL（サーバーのURL）が設定されていません');
  } else if (!S.sitePass) {
    goGate();
  } else if (S.session) {
    // 前回の卓に自動で戻る
    show('lobby');
    connect(S.session);
    goLobby();
  } else {
    goLobby();
  }
})();
