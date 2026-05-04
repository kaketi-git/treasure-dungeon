const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");

const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, "index.html");
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// ========== ゲーム定数 ==========
const BOX_CONTENTS = [
  { type: "coin",   label: "コイン",         value: 10,  emoji: "🪙" },
  { type: "coin",   label: "コイン",         value: 10,  emoji: "🪙" },
  { type: "coin",   label: "コイン",         value: 10,  emoji: "🪙" },
  { type: "coin",   label: "コイン",         value: 20,  emoji: "💰" },
  { type: "coin",   label: "コイン",         value: 20,  emoji: "💰" },
  { type: "coin",   label: "大金貨",         value: 50,  emoji: "💎" },
  { type: "rare",   label: "魔法の剣",       value: 80,  emoji: "⚔️"  },
  { type: "rare",   label: "竜のウロコ",     value: 100, emoji: "🐉" },
  { type: "rare",   label: "古代の宝石",     value: 120, emoji: "💠" },
  { type: "bomb",   label: "爆弾！",         value: 0,   emoji: "💣" },
  { type: "bomb",   label: "呪いの箱",       value: 0,   emoji: "☠️"  },
  { type: "bomb",   label: "大爆発！",       value: 0,   emoji: "🔥" },
];

const MAX_BOXES_PER_ROUND = 8;

// ========== 部屋管理 ==========
const rooms = {}; // roomId -> RoomState

function generateRoomId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function createRoom(hostId, hostName) {
  const roomId = generateRoomId();
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
    startPlayerIndex: -1, // ← 【追加】スタートプレイヤーのインデックス管理
    escapedThisRound: [],
    eliminatedThisRound: [],
    log: [],
  };
  return roomId;
}

function getRoomByPlayer(playerId) {
  return Object.values(rooms).find(r =>
    r.players.some(p => p.id === playerId)
  );
}

function getPlayer(room, playerId) {
  return room.players.find(p => p.id === playerId);
}

// ========== 宝箱生成 ==========
function generateBoxes() {
  const coins = BOX_CONTENTS.filter(c => c.type === 'coin');
  const bombs = BOX_CONTENTS.filter(c => c.type === 'bomb');
  const rares = BOX_CONTENTS.filter(c => c.type === 'rare');

  // 【追加】最低1つずつコインと爆弾を確定させる
  const pickedCoin = coins.splice(Math.floor(Math.random() * coins.length), 1)[0];
  const pickedBomb = bombs.splice(Math.floor(Math.random() * bombs.length), 1)[0];

  // 残りから6つ選ぶ
  const remainingPool = [...coins, ...bombs, ...rares];
  for (let i = remainingPool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [remainingPool[i], remainingPool[j]] = [remainingPool[j], remainingPool[i]];
  }
  const pickedOthers = remainingPool.slice(0, MAX_BOXES_PER_ROUND - 2);

  // 確定枠とランダム枠を合わせて再度シャッフル
  const finalPool = [pickedCoin, pickedBomb, ...pickedOthers];
  for (let i = finalPool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [finalPool[i], finalPool[j]] = [finalPool[j], finalPool[i]];
  }

  return finalPool.map((item, idx) => ({
    id: idx, opened: false, content: null, _content: item,
  }));
}

// ========== ラウンド開始 ==========
function startRound(room) {
  room.round += 1;
  room.phase = "playing";
  room.boxes = generateBoxes();
  room.openedBoxes = [];
  room.escapedThisRound = [];
  room.eliminatedThisRound = [];
  room.currentTurnIndex = 0;

  const alive = room.players.filter(p => !p.eliminated);
  alive.forEach(p => {
    p.roundCoins = 0;
    p.escaped = false;
    p.eliminatedThisRound = false;
  });

  // 【追加】スタートプレイヤーを毎ターンローテーションさせる
if (alive.length === 0) return; // 安全策を追加
room.startPlayerIndex = (room.startPlayerIndex + 1) % alive.length;
  const ordered = [
    ...alive.slice(room.startPlayerIndex),
    ...alive.slice(0, room.startPlayerIndex)
  ];
  room.turnOrder = ordered.map(p => p.id);
  
  const startPlayer = getPlayer(room, room.turnOrder[0]);
  addLog(room, `⚔️ ラウンド ${room.round} 開始！ (先攻: ${startPlayer.name})`);
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
  // 【追加】未開封の宝箱の中身をカウントする（ヒント機能用）
  const unopened = room.boxes ? room.boxes.filter(b => !b.opened).map(b => b._content.type) : [];
  const hints = {
    coin: unopened.filter(t => t === 'coin').length,
    rare: unopened.filter(t => t === 'rare').length,
    bomb: unopened.filter(t => t === 'bomb').length,
  };

  return {
    id: room.id,
    phase: room.phase,
    round: room.round,
    maxRounds: room.maxRounds,
    host: room.host,
    hints: hints, // ← 【追加】ヒントをクライアントに送る
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      totalCoins: p.totalCoins,
      roundCoins: p.roundCoins,
      escaped: p.escaped,
      eliminated: p.eliminated,
      eliminatedThisRound: p.eliminatedThisRound,
      isReady: p.isReady, // ← 【追加】準備完了フラグ
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
function advanceTurn(room) {
  if (!room.turnOrder) return;
  // アクティブなプレイヤーだけスキップ
  const activePlayers = room.players.filter(
    p => !p.eliminated && !p.escaped && !p.eliminatedThisRound
  );
  if (activePlayers.length === 0) {
    endRound(room);
    return;
  }

  // 次のアクティブプレイヤーへ
  let tries = 0;
  do {
    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.turnOrder.length;
    tries++;
    if (tries > room.turnOrder.length) {
      endRound(room);
      return;
    }
  } while (!isActivePlayer(room, room.turnOrder[room.currentTurnIndex]));
}

function isActivePlayer(room, playerId) {
  const p = getPlayer(room, playerId);
  // 修正: 接続が切れているプレイヤーも「アクティブではない」とみなしてスキップさせる
  return p && !p.eliminated && !p.escaped && !p.eliminatedThisRound && 
         (p.ws && p.ws.readyState === WebSocket.OPEN);
}

function getCurrentPlayer(room) {
  if (!room.turnOrder || room.turnOrder.length === 0) return null;
  return getPlayer(room, room.turnOrder[room.currentTurnIndex]);
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
    if (player.roundCoins === 0) {
      // 【追加】獲得コイン0の時に爆弾を引いたペナルティ
      player.totalCoins = Math.max(0, player.totalCoins - 10);
      addLog(room, `💣 ${player.name} は手ぶらで ${box._content.emoji} を引いた！所持コインから10失った！`);
    } else {
      player.roundCoins = 0;
      addLog(room, `💣 ${player.name} が ${box._content.emoji} を引いた！ラウンド獲得物消滅！`);
    }
    player.eliminatedThisRound = true;
    room.eliminatedThisRound.push(playerId);
  } else {
    player.roundCoins += box._content.value;
    addLog(room, `${player.name} が ${box._content.emoji}${box._content.label}（+${box._content.value}）を獲得！`);
  }

  // 宝箱が全部開いたら強制終了
  const remainingBoxes = room.boxes.filter(b => !b.opened);
  if (remainingBoxes.length === 0) {
    endRound(room);
    return { ok: true };
  }

  advanceTurn(room);

  // 全員行動不能ならラウンド終了
  const active = room.players.filter(p => !p.eliminated && !p.escaped && !p.eliminatedThisRound);
  if (active.length === 0) endRound(room);

  return { ok: true };
}

// ========== 脱出 ==========
function escape(room, playerId) {
  const player = getPlayer(room, playerId);
  if (!player || player.escaped || player.eliminatedThisRound) return { error: "行動できません" };

  const current = getCurrentPlayer(room);
  if (!current || current.id !== playerId) return { error: "あなたのターンではありません" };

  player.escaped = true;
  room.escapedThisRound.push(playerId);
  addLog(room, `🏃 ${player.name} が脱出！${player.roundCoins}コインを安全に確保`);

  advanceTurn(room);

  const active = room.players.filter(p => !p.eliminated && !p.escaped && !p.eliminatedThisRound);
  if (active.length === 0) endRound(room);

  return { ok: true };
}

// ========== ラウンド終了 ==========
function endRound(room) {
  room.phase = "roundEnd";

  // 脱出成功者はラウンドコイン確定
  room.players.forEach(p => {
    if (p.escaped) {
      p.totalCoins += p.roundCoins;
    }
    // 爆弾を踏んだ人はroundCoinsリセット済み
    p.roundCoins = 0;
    p.escaped = false;
    p.eliminatedThisRound = false;
  });

  addLog(room, `🏁 ラウンド ${room.round} 終了`);
  broadcastRoom(room);

  // 最終ラウンド判定
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

// ========== WebSocket ハンドラ ==========
// server.js の 217行目付近からの WebSocket ハンドラを以下のように修正します

wss.on("connection", (ws) => {
  let playerId = null;
  let currentRoomId = null; // ← 【追加】この接続が現在いるルームIDを直接保持する

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

// ===== 準備完了の切り替え (switch文の中に追加) =====
      case "toggleReady": {
        const room = rooms[currentRoomId];
        if (!room || room.phase !== "lobby") return;
        const player = getPlayer(room, playerId);
        if (player && room.host !== playerId) {
          player.isReady = !player.isReady;
          broadcastRoom(room);
        }
        break;
      }

// switch文の中に追加する例
case "leaveRoom": {
  const room = rooms[currentRoomId];
  if (!room) return;
  
  if (playerId === room.host) {
    // ホスト退出なら全員に通知して部屋削除
    room.players.forEach(p => {
      if (p.ws) p.ws.send(JSON.stringify({ type: "error", message: "ホストが退室したため解散しました" }));
    });
    delete rooms[currentRoomId];
  } else {
    room.players = room.players.filter(p => p.id !== playerId);
    broadcastRoom(room);
  }
  break;
}

      // ===== ゲーム開始 (startGameの判定を以下のように修正) =====
      case "startGame": {
        const room = rooms[currentRoomId];
        if (!room) return;
        if (room.host !== playerId) return;
        
        // 【追加】ホスト以外の全員が準備完了しているかチェック
const notReady = room.players.some(p => 
  p.id !== room.host && 
  !p.isReady && 
  (p.ws && p.ws.readyState === WebSocket.OPEN)
);
        if (notReady) {
          ws.send(JSON.stringify({ type: "error", message: "全員が準備完了になるまで開始できません" }));
          return;
        }
        if (room.players.length < 2) {
          ws.send(JSON.stringify({ type: "error", message: "2人以上必要です" }));
          return;
        }
        startRound(room);
        broadcastRoom(room);
        break;
      }

      // ===== 部屋を作成 =====
      case "createRoom": {
        playerId = msg.playerId || generateRoomId() + "_p";
        const roomId = createRoom(playerId, msg.name);
        currentRoomId = roomId; // ← 【追加】
        const room = rooms[roomId];
        room.players.push({
  id: playerId,
  name: msg.name || "プレイヤー1",
  ws,
  totalCoins: 0, roundCoins: 0, escaped: false, eliminated: false, eliminatedThisRound: false,
  isReady: true // ← 【追加】ホストは常に準備完了扱いにする
});
        ws.send(JSON.stringify({ type: "joined", roomId, playerId }));
        broadcastRoom(room);
        break;
      }

      // ===== 部屋に参加 =====
      case "joinRoom": {
        const room = rooms[msg.roomId];
        if (!room) {
          ws.send(JSON.stringify({ type: "error", message: "部屋が見つかりません" }));
          return;
        }
        if (room.phase !== "lobby") {
          ws.send(JSON.stringify({ type: "error", message: "ゲームはすでに始まっています" }));
          return;
        }
        if (room.players.length >= 8) {
          ws.send(JSON.stringify({ type: "error", message: "部屋が満員です" }));
          return;
        }

        // ▼ 【修正】同じブラウザの別タブでテストした時のID重複バグを防ぐ
        let joinPlayerId = msg.playerId;
        if (!joinPlayerId || room.players.some(p => p.id === joinPlayerId)) {
          joinPlayerId = generateRoomId() + "_p";
        }
        playerId = joinPlayerId;
        currentRoomId = room.id; // ← 【追加】

        room.players.push({
  id: playerId,
  name: msg.name || `プレイヤー${room.players.length + 1}`,
  ws,
  totalCoins: 0, roundCoins: 0, escaped: false, eliminated: false, eliminatedThisRound: false,
  isReady: false // ← 【追加】参加者は最初は準備未完了にする
});
        addLog(room, `👤 ${msg.name} が参加しました`);
        ws.send(JSON.stringify({ type: "joined", roomId: room.id, playerId }));
        broadcastRoom(room);
        break;
      }

      // ===== 以下、getRoomByPlayer を使わず rooms[currentRoomId] を使うように一貫して修正 =====

      case "openBox": {
        const room = rooms[currentRoomId]; // ← 【修正】
        if (!room || room.phase !== "playing") return;
        const result = openBox(room, playerId, msg.boxId);
        if (result.error) {
          ws.send(JSON.stringify({ type: "error", message: result.error }));
        } else {
          broadcastRoom(room);
        }
        break;
      }

      case "escape": {
        const room = rooms[currentRoomId]; // ← 【修正】
        if (!room || room.phase !== "playing") return;
        const result = escape(room, playerId);
        if (result.error) {
          ws.send(JSON.stringify({ type: "error", message: result.error }));
        } else {
          broadcastRoom(room);
        }
        break;
      }

      case "reconnect": {
        playerId = msg.playerId;
        const room = rooms[msg.roomId];
        if (!room) return;
        currentRoomId = room.id; // ← 【追加】
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
    if (!playerId || !currentRoomId) return; // ← 【修正】
    const room = rooms[currentRoomId];       // ← 【修正】
    if (!room) return;
    const player = getPlayer(room, playerId);
    if (player) {
      addLog(room, `⚠️ ${player.name} が切断しました`);
      broadcastRoom(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`🎮 宝箱ダンジョン サーバー起動: ws://localhost:${PORT}`);
});
