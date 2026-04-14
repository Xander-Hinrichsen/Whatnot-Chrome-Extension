const roomData = new Map<string, string>();

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
.cell{font-size:min(28vw,140px);font-weight:800;line-height:1;padding:20px 32px;border-radius:16px;text-align:center;min-width:50%;transition:all .12s ease}
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
  <div class="info" id="info">Loading data...</div>
  <div class="display-area"><div class="cell" id="cell">...</div></div>
  <div class="sub" id="sub"></div>
  <div class="nav">
    <button id="prev" disabled>Prev</button>
    <button id="next" disabled>Next</button>
  </div>
  <div class="status" id="status"></div>
</div>
<script>
(function(){
  var roomId="${roomId}";
  var cellEl=document.getElementById("cell");
  var infoEl=document.getElementById("info");
  var subEl=document.getElementById("sub");
  var statusEl=document.getElementById("status");
  var prevBtn=document.getElementById("prev");
  var nextBtn=document.getElementById("next");

  var cards=[];
  var totalBatches=1;
  var batch=0;
  var idx=0;

  function render(){
    if(!cards.length)return;
    var c=cards[idx];
    var nb=totalBatches;

    var cell,cls,sub;
    if(c.status==="excluded"){
      cell="\\u2715";cls="excluded";sub=c.reason||"Excluded";
    }else if(c.batchIdx===batch){
      cell=c.cell;cls="hit";sub=c.ownerInfo;
    }else{
      cell="\\u2014";cls="skip";sub="Not in this batch";
    }

    cellEl.textContent=cell;
    cellEl.className="cell "+cls;
    infoEl.textContent="Batch "+(batch+1)+"/"+nb+" \\u00b7 Card #"+c.cardNum+" ("+(idx+1)+"/"+cards.length+")";
    subEl.textContent=sub;

    prevBtn.disabled=(idx===0&&batch===0);
    var isLast=idx>=cards.length-1;
    var isLastBatch=batch>=nb-1;
    if(isLast&&!isLastBatch){nextBtn.textContent="Batch "+(batch+2);nextBtn.disabled=false;}
    else if(isLast&&isLastBatch){nextBtn.textContent="Done";nextBtn.disabled=true;}
    else{nextBtn.textContent="Next";nextBtn.disabled=false;}
  }

  function goNext(){
    if(idx<cards.length-1){idx++;render();}
    else if(batch<totalBatches-1){batch++;idx=0;render();}
  }
  function goPrev(){
    if(idx>0){idx--;render();}
    else if(batch>0){batch--;idx=cards.length-1;render();}
  }

  nextBtn.onclick=goNext;
  prevBtn.onclick=goPrev;

  fetch(location.origin+"/api/"+roomId+"/data").then(function(r){return r.json();}).then(function(d){
    cards=d.cards||[];
    totalBatches=d.totalBatches||1;
    batch=0;idx=0;
    if(cards.length){
      statusEl.textContent=cards.length+" cards loaded";
      render();
    }else{
      infoEl.textContent="No data yet. Start sorting on the PC first.";
    }
  }).catch(function(){
    infoEl.textContent="Failed to load data. Check the session.";
  });
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
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...CORS },
    });
  }

  const dataMatch = path.match(/^\/api\/([a-zA-Z0-9_-]+)\/data$/);
  if (dataMatch) {
    const roomId = dataMatch[1];
    if (req.method === "POST") {
      return req.text().then((body) => {
        roomData.set(roomId, body);
        return new Response("ok", { headers: CORS });
      });
    }
    if (req.method === "GET") {
      const body = roomData.get(roomId) || "{}";
      return new Response(body, {
        headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
      });
    }
  }

  return new Response("Not found", { status: 404, headers: CORS });
});
