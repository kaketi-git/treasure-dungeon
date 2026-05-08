const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");

const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, "index.html");
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

// ========== ゲーム定数 ==========
const BOX_CONTENTS = [
  { type: "coin", label: "コイン",     value: 10,  emoji: "🪙" },
  { type: "coin", label: "コイン",     value: 10,  emoji: "🪙" },
  { type: "coin", label: "コイン",     value: 10,  emoji: "🪙" },
  { type: "coin", label: "コイン",     value: 20,  emoji: "💰" },
  { type: "coin", label: "コイン",     value: 20,  emoji: "💰" },
  { type: "coin", label: "大金貨",     value: 50,  emoji: "💎" },
  { type: "rare", label: "魔法の剣",   value: 80,  emoji: "⚔️"  },
  { type: "rare", label: "竜のウロコ", value: 100, emoji: "🐉" },
  { type: "rare", label: "古代の宝石", value: 120, emoji: "💠" },
  { type: "bomb", label: "爆弾！",     value: 0,   emoji: "💣" },
  { type: "bomb", label: "呪いの箱",   value: 0,   emoji: "☠️"  },
  { type: "bomb", label: "大爆発！",   value: 0,   emoji: "🔥" },
];

const MAX_BOXES_PER_ROUND = 8;

// ========== 部屋管理 ==========
const rooms = {};

function generateId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function createRoom(hostId, hostName) {
  const roomId = generateId();
  rooms[roomId] = {
    id: roomId,
    phase: "lobby",
    players: [],
    host: hostId,
    round: 0,
    maxRounds: 5,
    boxes: [],
    openedBoxes: [],
    currentTurnIndex: 0,
    turnOrder: [],
    log: [],
    endingRound: false, // 二重呼び出し防止フラグ
  };
  return roomId;
}

function getRoomByPlayer(playerId) {
  return Object.values(rooms).find(r => r.players.some(p => p.id === playerId));
}

function getPlayer(room, playerId) {
  return room.players.find(p => p.id === playerId);
}

// ========== 宝箱生成 ==========
function generateBoxes() {
  const pool = [...BOX_CONTENTS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, MAX_BOXES_PER_ROUND).map((item, idx) => ({
    id: idx,
    opened: false,
    content: null,
    _content: item,
  }));
}

// ========== ラウンド開始 ==========
function startRound(room) {
  room.round += 1;
  room.phase = "playing";
  room.boxes = generateBoxes();
  room.openedBoxes = [];
  room.endingRound = false;
  room.currentTurnIndex = 0;

  const alive = room.players.filter(p => !p.eliminated);
  alive.forEach(p => {
    p.roundCoins = 0;
    p.escaped = false;
    p.eliminatedThisRound = false;
  });

  room.turnOrder = alive.map(p => p.id);
  addLog(room, `⚔️ ラウンド ${room.round} 開始！`);
}

function addLog(room, message) {
  room.log.unshift({ message, time: Date.now() });
  if (room.log.length > 30) room.log.pop();
}

// ========== ブロードキャスト ==========
function broadcastRoom(room) {
  const state = buildPublicState(room);
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify({ type: "state", state }));
    }
  });
}

function buildPublicState(room) {
  return {
    id: room.id,
    phase: room.phase,
    round: room.round,
    maxRounds: room.maxRounds,
    host: room.host,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      totalCoins: p.totalCoins,
      roundCoins: p.roundCoins,
      escaped: p.escaped,
      eliminated: p.eliminated,
      eliminatedThisRound: p.eliminatedThisRound,
      connected: p.ws && p.ws.readyState === WebSocket.OPEN,
    })),
    boxes: room.boxes.map(b => ({
      id: b.id,
      opened: b.opened,
      content: b.opened ? b._content : null,
    })),
    currentTurn: room.turnOrder ? room.turnOrder[room.currentTurnIndex] : null,
    log: room.log.slice(0, 10),
  };
}

// ========== ターン進行 ==========
// 戻り値: true=次のプレイヤーへ進んだ / false=アクティブなプレイヤーがいない
function advanceTurn(room) {
  if (!room.turnOrder || room.turnOrder.length === 0) return false;

  const activePlayers = room.players.filter(
    p => !p.eliminated && !p.escaped && !p.eliminatedThisRound
  );
  if (activePlayers.length === 0) return false;

  let tries = 0;
  do {
    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
    tries++;
    if (tries > room.turnOrder.length) return false;
  } while (!isActivePlayer(room, room.turnOrder[room.currentTurnIndex]));

  return true;
}

function isActivePlayer(room, playerId) {
  const p = getPlayer(room, playerId);
  return p && !p.eliminated && !p.escaped && !p.eliminatedThisRound;
}

function getCurrentPlayer(room) {
  if (!room.turnOrder || room.turnOrder.length === 0) return null;
  return getPlayer(room, room.turnOrder[room.currentTurnIndex]);
}

// ========== ラウンド終了 ==========
function endRound(room) {
  // 二重呼び出し防止
  if (room.endingRound || room.phase === "roundEnd" || room.phase === "gameOver") return;
  room.endingRound = true;
  room.phase = "roundEnd";

  // 脱出済み（escaped=true）のプレイヤーのみコインを確定
  // ※宝箱が尽きた場合は呼び出し前に escaped=true にセットしてから呼ぶこと
  room.players.forEach(p => {
    if (p.escaped) {
      p.totalCoins += p.roundCoins;
      addLog(room, `✅ ${p.name} が ${p.roundCoins}コインを持ち帰った！（合計: ${p.totalCoins}）`);
    }
    // リセット
    p.roundCoins = 0;
    p.escaped = false;
    p.eliminatedThisRound = false;
  });

  addLog(room, `🏁 ラウンド ${room.round} 終了`);
  broadcastRoom(room);

  if (room.round >= room.maxRounds) {
    setTimeout(() => endGame(room), 3000);
  } else {
    setTimeout(() => {
      startRound(room);
      broadcastRoom(room);
    }, 4000);
  }
}

// ========== ゲーム終了 ==========
function endGame(room) {
  room.phase = "gameOver";
  room.players.sort((a, b) => b.totalCoins - a.totalCoins);
  addLog(room, `🏆 ゲーム終了！優勝: ${room.players[0].name}（${room.players[0].totalCoins}コイン）`);
  broadcastRoom(room);
}

// ========== 宝箱を開ける ==========
function openBox(room, playerId, boxId) {
  const player = getPlayer(room, playerId);
  const box = room.boxes.find(b => b.id === boxId);

  if (!box || box.opened) return { error: "その宝箱は既に開いています" };
  if (!player || player.escaped || player.eliminatedThisRound) return { error: "あなたはこのラウンドで行動できません" };

  const current = getCurrentPlayer(room);
  if (!current || current.id !== playerId) return { error: "あなたのターンではありません" };

  box.opened = true;
  box.content = box._content;
  room.openedBoxes.push(box);

  if (box._content.type === "bomb") {
    player.roundCoins = 0;
    player.eliminatedThisRound = true;
    addLog(room, `💣 ${player.name} が ${box._content.emoji}${box._content.label} を引いた！ラウンド獲得物消滅！`);
  } else {
    player.roundCoins += box._content.value;
    addLog(room, `${player.name} が ${box._content.emoji}${box._content.label}（+${box._content.value}）を獲得！`);
  }

  // 宝箱が全部開いたら → 残存プレイヤー全員を強制脱出扱いにしてスコア確定
  const remainingBoxes = room.boxes.filter(b => !b.opened);
  if (remainingBoxes.length === 0) {
    room.players.forEach(p => {
      if (!p.eliminated && !p.eliminatedThisRound && !p.escaped) {
        p.escaped = true;
      }
    });
    endRound(room);
    return { ok: true };
  }

  // ターンを進める。進める先がなければラウンド終了
  const canContinue = advanceTurn(room);
  if (!canContinue) {
    endRound(room);
  }

  return { ok: true };
}

// ========== 脱出 ==========
function escape(room, playerId) {
  const player = getPlayer(room, playerId);
  if (!player || player.escaped || player.eliminatedThisRound) return { error: "行動できません" };

  const current = getCurrentPlayer(room);
  if (!current || current.id !== playerId) return { error: "あなたのターンではありません" };

  player.escaped = true;
  addLog(room, `🏃 ${player.name} が脱出！${player.roundCoins}コインを安全に確保`);

  const canContinue = advanceTurn(room);
  if (!canContinue) {
    endRound(room);
  }

  return { ok: true };
}

// ========== WebSocket ハンドラ ==========
wss.on("connection", (ws) => {
  let playerId = null;

  // Render等でのタイムアウト対策 ping/pong
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case "createRoom": {
        playerId = msg.playerId || generateId() + "_p";
        const roomId = createRoom(playerId, msg.name);
        const room = rooms[roomId];
        room.players.push({
          id: playerId,
          name: msg.name || "プレイヤー1",
          ws,
          totalCoins: 0,
          roundCoins: 0,
          escaped: false,
          eliminated: false,
          eliminatedThisRound: false,
        });
        ws.send(JSON.stringify({ type: "joined", roomId, playerId }));
        broadcastRoom(room);
        break;
      }

      case "joinRoom": {
        const room = rooms[msg.roomId];
        if (!room) { ws.send(JSON.stringify({ type: "error", message: "部屋が見つかりません" })); return; }
        if (room.phase !== "lobby") { ws.send(JSON.stringify({ type: "error", message: "ゲームはすでに始まっています" })); return; }
        if (room.players.length >= 8) { ws.send(JSON.stringify({ type: "error", message: "部屋が満員です" })); return; }
        playerId = msg.playerId || generateId() + "_p";
        room.players.push({
          id: playerId,
          name: msg.name || `プレイヤー${room.players.length + 1}`,
          ws,
          totalCoins: 0,
          roundCoins: 0,
          escaped: false,
          eliminated: false,
          eliminatedThisRound: false,
        });
        addLog(room, `👤 ${msg.name} が参加しました`);
        ws.send(JSON.stringify({ type: "joined", roomId: room.id, playerId }));
        broadcastRoom(room);
        break;
      }

      case "startGame": {
        const room = getRoomByPlayer(playerId);
        if (!room) return;
        if (room.host !== playerId) { ws.send(JSON.stringify({ type: "error", message: "ホストのみ開始できます" })); return; }
        if (room.players.length < 2) { ws.send(JSON.stringify({ type: "error", message: "2人以上必要です" })); return; }
        startRound(room);
        broadcastRoom(room);
        break;
      }

      case "openBox": {
        const room = getRoomByPlayer(playerId);
        if (!room || room.phase !== "playing") return;
        const result = openBox(room, playerId, msg.boxId);
        if (result.error) { ws.send(JSON.stringify({ type: "error", message: result.error })); }
        else { broadcastRoom(room); }
        break;
      }

      case "escape": {
        const room = getRoomByPlayer(playerId);
        if (!room || room.phase !== "playing") return;
        const result = escape(room, playerId);
        if (result.error) { ws.send(JSON.stringify({ type: "error", message: result.error })); }
        else { broadcastRoom(room); }
        break;
      }

      case "reconnect": {
        playerId = msg.playerId;
        const room = rooms[msg.roomId];
        if (!room) return;
        const player = getPlayer(room, playerId);
        if (player) {
          player.ws = ws;
          ws.send(JSON.stringify({ type: "joined", roomId: room.id, playerId }));
          broadcastRoom(room);
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    if (!playerId) return;
    const room = getRoomByPlayer(playerId);
    if (!room) return;
    const player = getPlayer(room, playerId);
    if (player) {
      addLog(room, `⚠️ ${player.name} が切断しました`);
      broadcastRoom(room);
    }
  });
});

// ping/pong で死活監視（30秒ごと）
const pingInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(pingInterval));

server.listen(PORT, () => {
  console.log(`🎮 宝箱ダンジョン サーバー起動: ws://localhost:${PORT}`);
});
