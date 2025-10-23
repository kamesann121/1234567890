// public/main.js
const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
let myNickname = null;
let myIcon = null;
let shop = [];

const $ = id => document.getElementById(id);
const nicknameInput = $('nickname'), setNameBtn = $('setName'), meNameSpan = $('meName');
const coinsEl = $('coins'), tapValueEl = $('tapValue'), myTapsEl = $('myTaps');
const tapImage = $('tapImage'), iconFile = $('iconFile'), uploadIconBtn = $('uploadIcon');
const shopList = $('shopList'), chatLog = $('chatLog'), chatInput = $('chatInput'), sendChatBtn = $('sendChat');
const rankList = $('rankList');

setNameBtn.onclick = () => {
  const nick = nicknameInput.value.trim();
  if (!nick) return alert('ニックネームを入力');
  ws.send(JSON.stringify({ type: 'setName', nickname: nick }));
};

uploadIconBtn.onclick = async () => {
  if (!myNickname) return alert('先にニックネームを設定');
  const f = iconFile.files[0];
  if (!f) return alert('ファイルを選んでください');
  const fd = new FormData();
  fd.append('icon', f);
  fd.append('nickname', myNickname);
  const res = await fetch('/upload-icon', { method: 'POST', body: fd });
  const json = await res.json();
  if (json.ok) {
    myIcon = json.icon;
    appendSystem('アイコンをアップロードしました');
  } else {
    appendSystem('アップロード失敗');
  }
};

tapImage.addEventListener('mousedown', () => sendTap());
tapImage.addEventListener('touchstart', (e) => { e.preventDefault(); sendTap(); }, { passive: false });

function sendTap() { if (!myNickname) return; ws.send(JSON.stringify({ type: 'tap' })); }

sendChatBtn.onclick = sendChat;
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

function sendChat() {
  if (!myNickname) return alert('ニックネームを設定してください');
  const txt = chatInput.value.trim();
  if (!txt) return;
  ws.send(JSON.stringify({ type: 'chat', text: txt }));
  chatInput.value = '';
}

ws.onmessage = (ev) => {
  const data = JSON.parse(ev.data);
  if (data.type === 'init') {
    shop = data.shop || [];
    renderShop();
    renderRanks(data.ranks || []);
    renderChats(data.chats || []);
    return;
  }
  if (data.type === 'setNameResult') {
    if (data.ok) {
      myNickname = data.nickname;
      meNameSpan.textContent = `あなた: ${myNickname}`;
      nicknameInput.value = '';
      appendSystem(`ニックネーム設定: ${myNickname}`);
    } else {
      if (data.reason === 'inuse') appendSystem('そのニックネームは使用中です');
      else if (data.reason === 'banned') appendSystem('そのニックネームはBANされています');
      else if (data.reason === 'admin_auth') appendSystem('admin認証失敗');
      else appendSystem('ニックネーム設定失敗');
    }
    return;
  }
  if (data.type === 'tap') {
    if (data.nickname === myNickname) {
      coinsEl.textContent = `コイン: ${data.coins}`;
      myTapsEl.textContent = `タップ数: ${data.taps}`;
      tapValueEl.textContent = `${data.tap_value} / タップ`;
    }
    return;
  }
  if (data.type === 'ranks') {
    renderRanks(data.ranks);
    return;
  }
  if (data.type === 'chat') {
    addChatMessage(data.nickname, data.icon, data.text, data.ts);
    return;
  }
  if (data.type === 'system') {
    appendSystem(data.text);
    return;
  }
  if (data.type === 'banned') {
    if (data.nickname === myNickname) {
      appendSystem('あなたはBANされました');
      ws.close();
    }
  }
  if (data.type === 'buyResult') {
    appendSystem(data.ok ? '購入成功' : '購入失敗: ' + (data.reason || ''));
    return;
  }
};

function renderShop() {
  shopList.innerHTML = shop.map(it => {
    return `<div class="item" data-id="${it.id}">
      <div>${escapeHtml(it.name)} - ${it.price}コイン</div>
      <button class="buy" data-id="${it.id}">買う</button>
    </div>`;
  }).join('');
  shopList.querySelectorAll('.buy').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.id;
    ws.send(JSON.stringify({ type: 'buy', itemId: id }));
  }));
}

function renderRanks(ranks) {
  rankList.innerHTML = (ranks || []).map(r => {
    const icon = r.icon ? `<img src="${r.icon}" alt="">` : `<img src="https://via.placeholder.com/36?text=?">`;
    return `<li class="rank-item">${icon}<div><strong>${escapeHtml(r.nickname)}</strong><div>タップ: ${r.taps} / コイン: ${r.coins}</div></div></li>`;
  }).join('');
}

function renderChats(chats) {
  chatLog.innerHTML = '';
  (chats || []).forEach(c => addChatMessage(c.nickname, c.icon, c.text, c.ts * 1000));
}

function addChatMessage(nick, icon, text, ts) {
  const time = new Date(ts).toLocaleTimeString();
  const img = icon ? `<img src="${icon}" alt="">` : `<img src="https://via.placeholder.com/40?text=?">`;
  chatLog.insertAdjacentHTML('beforeend', `<div class="chat-entry">${img}<div><div class="meta"><strong>${escapeHtml(nick)}</strong> <span>${time}</span></div><div class="text">${escapeHtml(text)}</div></div></div>`);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendSystem(text) {
  chatLog.insertAdjacentHTML('beforeend', `<div class="chat-entry"><div style="width:40px;height:40px;border-radius:50%;background:#ddd;"></div><div><div class="meta"><em>system</em></div><div class="text">${escapeHtml(text)}</div></div></div>`);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
