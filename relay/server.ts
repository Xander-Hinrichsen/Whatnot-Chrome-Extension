const rooms = new Map<string, Room>();

interface Room {
  host: WebSocket | null;
  phones: Set<WebSocket>;
  lastState: string | null;
}

function getOrCreateRoom(id: string): Room {
  let room = rooms.get(id);
  if (!room) {
    room = { host: null, phones: new Set(), lastState: null };
    rooms.set(id, room);
  }
  return room;
}

function broadcast(room: Room, msg: string) {
  for (const ws of room.phones) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function handleHostSocket(ws: WebSocket, room: Room) {
  if (room.host && room.host.readyState === WebSocket.OPEN) {
    room.host.close(4000, "replaced");
  }
  room.host = ws;
  ws.addEventListener("message", (e) => {
    const raw = typeof e.data === "string" ? e.data : "";
    room.lastState = raw;
    broadcast(room, raw);
  });
  ws.addEventListener("close", () => {
    if (room.host === ws) room.host = null;
  });
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function phoneHtml(roomId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Sort Remote</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%;overflow:hidden;font-family:-apple-system,system-ui,sans-serif;background:#fafafa;color:#333}
.wrap{display:flex;flex-direction:column;height:100%;padding:10px}
.info{text-align:center;font-size:14px;color:#666;padding:6px 0;flex-shrink:0}
.display-area{flex:1;display:flex;align-items:center;justify-content:center;min-height:0}
.cell{font-size:min(28vw,140px);font-weight:800;line-height:1;padding:20px 32px;border-radius:16px;text-align:center;min-width:50%;transition:all .15s ease}
.cell.hit{background:#e8f5e9;color:#1b5e20;border:4px solid #66bb6a}
.cell.skip{background:#fff3e0;color:#e65100;border:4px solid #ffb74d;font-size:min(8vw,36px);font-weight:600}
.cell.excluded{background:#fce4ec;color:#b71c1c;border:4px solid #ef9a9a;font-size:min(7vw,30px);font-weight:600}
.sub{text-align:center;font-size:13px;color:#888;min-height:1.4em;padding:4px 0;flex-shrink:0}
.nav{display:flex;gap:12px;padding:8px 0;flex-shrink:0}
.nav button{flex:1;padding:20px 10px;font-size:22px;font-weight:700;border:2px solid #bbb;border-radius:12px;background:#f0f0f0;color:#333;cursor:pointer;touch-action:manipulation}
.nav button:active{background:#ddd;transform:scale(.97)}
.nav button:disabled{opacity:.35;pointer-events:none}
.status{text-align:center;font-size:11px;color:#aaa;padding:4px 0;flex-shrink:0}
</style>
</head>
<body>
<div class="wrap">
  <div class="info" id="info">Connecting...</div>
  <div class="display-area"><div class="cell" id="cell">\\u2014</div></div>
  <div class="sub" id="sub"></div>
  <div class="nav">
    <button id="prev">Prev</button>
    <button id="next">Next</button>
  </div>
  <div class="status" id="status"></div>
</div>
<script>
(function(){
  var roomId="${roomId}";
  var base=location.origin;
  var cellEl=document.getElementById("cell");
  var infoEl=document.getElementById("info");
  var subEl=document.getElementById("sub");
  var statusEl=document.getElementById("status");
  var prevBtn=document.getElementById("prev");
  var nextBtn=document.getElementById("next");
  var lastJson="";

  function poll(){
    fetch(base+"/api/"+roomId+"/state").then(function(r){return r.text();}).then(function(txt){
      if(txt&&txt!==lastJson){
        lastJson=txt;
        try{
          var s=JSON.parse(txt);
          if(s.type==="state"&&s.data){
            var d=s.data;
            cellEl.textContent=d.cell||"\\u2014";
            cellEl.className="cell "+(d.cellClass||"");
            infoEl.textContent="Batch "+d.batch+" \\u00b7 Card #"+d.cardNum+" ("+d.cardIdx+"/"+d.totalCards+")";
            subEl.textContent=d.sub||"";
            prevBtn.disabled=!!d.prevDisabled;
            nextBtn.disabled=!!d.nextDisabled;
            nextBtn.textContent=d.nextLabel||"Next";
          }
        }catch(ex){}
      }
      statusEl.textContent="Connected";
    }).catch(function(){
      statusEl.textContent="Reconnecting...";
    });
  }

  function sendCmd(action){
    fetch(base+"/api/"+roomId+"/command",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({type:"command",action:action})
    }).catch(function(){});
  }

  prevBtn.onclick=function(){sendCmd("prev");};
  nextBtn.onclick=function(){sendCmd("next");};

  setInterval(poll,300);
  poll();
})();
</script>
</body>
</html>`;
}

Deno.serve({ port: parseInt(Deno.env.get("PORT") || "7777") }, (req) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (path === "/") {
    return new Response("Whatnot Sort Relay is running.", {
      headers: { "content-type": "text/plain", ...CORS },
    });
  }

  const roomPageMatch = path.match(/^\/room\/([a-zA-Z0-9_-]+)$/);
  if (roomPageMatch) {
    return new Response(phoneHtml(roomPageMatch[1]), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...CORS,
      },
    });
  }

  // Phone HTTP polling: get current state
  const stateMatch = path.match(/^\/api\/([a-zA-Z0-9_-]+)\/state$/);
  if (stateMatch && req.method === "GET") {
    const room = rooms.get(stateMatch[1]);
    const body = room?.lastState || "";
    return new Response(body, {
      headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
    });
  }

  // Phone HTTP polling: send command to host
  const cmdMatch = path.match(/^\/api\/([a-zA-Z0-9_-]+)\/command$/);
  if (cmdMatch && req.method === "POST") {
    const room = rooms.get(cmdMatch[1]);
    if (room?.host && room.host.readyState === WebSocket.OPEN) {
      req.text().then((body) => room.host!.send(body)).catch(() => {});
    }
    return new Response("ok", { headers: CORS });
  }

  // Host WebSocket (PC extension connects here)
  const wsMatch = path.match(/^\/ws\/([a-zA-Z0-9_-]+)$/);
  if (wsMatch) {
    const roomId = wsMatch[1];
    const role = url.searchParams.get("role") || "phone";
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    const room = getOrCreateRoom(roomId);
    if (role === "host") {
      handleHostSocket(socket, room);
    }
    return response;
  }

  return new Response("Not found", { status: 404, headers: CORS });
});
