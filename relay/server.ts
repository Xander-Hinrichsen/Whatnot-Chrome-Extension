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
html,body{height:100%;font-family:-apple-system,system-ui,sans-serif;background:#fafafa;color:#333}
.wrap{display:flex;flex-direction:column;height:100%;padding:10px}
.info{text-align:center;font-size:14px;color:#666;padding:4px 0;flex-shrink:0}
.display-area{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:0}
.cell{font-size:min(28vw,140px);font-weight:800;line-height:1;padding:20px 32px;border-radius:16px;text-align:center;min-width:50%;transition:all .12s ease}
.cell.hit{background:#e8f5e9;color:#1b5e20;border:4px solid #66bb6a}
.cell.skip{background:#fff3e0;color:#e65100;border:4px solid #ffb74d;font-size:min(8vw,36px);font-weight:600}
.cell.giveaway{background:#ede7f6;color:#4a148c;border:4px solid #b39ddb}
.cardnum{font-size:min(14vw,64px);font-weight:700;text-align:center;margin-top:6px;min-height:1.2em;line-height:1.1}
.sub{text-align:center;font-size:13px;color:#888;min-height:1.4em;padding:4px 0;flex-shrink:0}
.nav{display:flex;gap:12px;padding:8px 0;flex-shrink:0}
.nav button{flex:1;padding:20px 10px;font-size:22px;font-weight:700;border:2px solid #bbb;border-radius:12px;background:#f0f0f0;color:#333;cursor:pointer;touch-action:manipulation}
.nav button:active{background:#ddd;transform:scale(.97)}
.nav button:disabled{opacity:.35;pointer-events:none}
.lookup{display:flex;align-items:center;gap:6px;font-size:12px;color:#888;padding:6px 0;flex-shrink:0;flex-wrap:wrap;justify-content:center}
.lookup select,.lookup input{padding:4px 6px;border:1px solid #bbb;border-radius:6px;font-size:12px}
.lookup input{width:48px;text-align:center;text-transform:uppercase}
.lookup-result{font-weight:500;color:#333}
.status{text-align:center;font-size:11px;color:#aaa;padding:4px 0;flex-shrink:0}
</style>
</head>
<body>
<div class="wrap">
  <div class="info" id="info">Loading data...</div>
  <div class="display-area">
    <div class="cell" id="cell">...</div>
    <div class="cardnum" id="cardnum"></div>
  </div>
  <div class="sub" id="sub"></div>
  <div class="nav">
    <button id="prev" disabled>Prev</button>
    <button id="next" disabled>Next</button>
  </div>
  <div class="lookup" id="lookupWrap" style="display:none">
    <span>Lookup:</span>
    <select id="lkBatch"></select>
    <input id="lkCell" placeholder="A1">
    <span class="lookup-result" id="lkResult"></span>
  </div>
  <div class="status" id="status"></div>
</div>
<script>
(function(){
  var roomId="${roomId}";
  var cellEl=document.getElementById("cell");
  var cardnumEl=document.getElementById("cardnum");
  var infoEl=document.getElementById("info");
  var subEl=document.getElementById("sub");
  var statusEl=document.getElementById("status");
  var prevBtn=document.getElementById("prev");
  var nextBtn=document.getElementById("next");
  var lookupWrap=document.getElementById("lookupWrap");
  var lkBatch=document.getElementById("lkBatch");
  var lkCell=document.getElementById("lkCell");
  var lkResult=document.getElementById("lkResult");

  var batches=[];
  var nBatches=1;
  var batch=0;
  var idx=0;

  function cards(){return batches[batch]?batches[batch].cards:[];}

  function render(){
    var cc=cards();
    if(!cc.length)return;
    var c=cc[idx];

    var label,cls,sub;
    if(c.status==="giveaway"){
      label="Giveaway";cls="giveaway";sub=c.owner;
    }else if(c.status==="hit"){
      label=c.cell;cls="hit";sub=c.ownerInfo;
    }else{
      label="\\u2014";cls="skip";sub="Not in this batch";
    }

    cellEl.textContent=label;
    cellEl.className="cell "+cls;
    infoEl.textContent="Batch "+(batch+1)+"/"+nBatches;
    var cn=c.status==="giveaway"?c.cardNum:"Card #"+c.cardNum;
    cardnumEl.textContent=cn+" ("+(idx+1)+"/"+cc.length+")";
    subEl.textContent=sub;

    prevBtn.disabled=(idx===0&&batch===0);
    var isLast=idx>=cc.length-1;
    var isLastBatch=batch>=nBatches-1;
    if(isLast&&!isLastBatch){nextBtn.textContent="Batch "+(batch+2);nextBtn.disabled=false;}
    else if(isLast&&isLastBatch){nextBtn.textContent="Done";nextBtn.disabled=true;}
    else{nextBtn.textContent="Next";nextBtn.disabled=false;}
  }

  function goNext(){
    var cc=cards();
    if(idx<cc.length-1){idx++;render();}
    else if(batch<nBatches-1){batch++;idx=0;render();}
  }
  function goPrev(){
    if(idx>0){idx--;render();}
    else if(batch>0){batch--;idx=cards().length-1;render();}
  }

  function doLookup(){
    var b=parseInt(lkBatch.value,10);
    var code=(lkCell.value||"").trim().toUpperCase();
    if(isNaN(b)||!code||!batches[b]){lkResult.textContent="";return;}
    var map=batches[b].cellToAccount||{};
    var entry=map[code];
    if(entry){
      var nums=(entry.cards||[]).map(function(n){return"#"+n;}).join(", ");
      lkResult.textContent=entry.owner+" \\u2014 "+(nums||"no cards");
    }else{lkResult.textContent="Empty cell";}
  }

  nextBtn.onclick=goNext;
  prevBtn.onclick=goPrev;
  lkBatch.onchange=doLookup;
  lkCell.oninput=doLookup;

  fetch(location.origin+"/api/"+roomId+"/data").then(function(r){return r.json();}).then(function(d){
    batches=d.batches||[];
    nBatches=d.totalBatches||1;
    batch=0;idx=0;
    if(batches.length&&cards().length){
      statusEl.textContent="Data loaded";
      lookupWrap.style.display="flex";
      for(var i=0;i<nBatches;i++){var o=document.createElement("option");o.value=String(i);o.textContent="Batch "+(i+1);lkBatch.appendChild(o);}
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
