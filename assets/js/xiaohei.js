(function(){
  if (window.__xiaohei) return; window.__xiaohei = true;
  var el = document.getElementById('xiaohei');
  if (!el) return;
  var sprite = el.querySelector('.xh-sprite');
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fx = document.createElement('div'); fx.id = 'xh-fx'; document.body.appendChild(fx);

  var w = function(){ return el.offsetWidth; };
  var h = function(){ return el.offsetHeight; };
  var x = Math.random()*(innerWidth-60)+8, y = Math.random()*(innerHeight-90)+40;
  var heading = Math.random()*6.28, turnRate = 0, speed = 40;
  var vx = 0, vy = 0, face = 1;
  var jumpY = 0, jT0 = -1, jH = 0, jDur = 540;
  var state = 'walk', until = 0, brainAt = 0, tx = 0, ty = 0, pend = null;
  var word = null, line = null, G = 1700, bannerEl = null;
  var parked = false, dragging = false, ddx = 0, ddy = 0, downX = 0, downY = 0, moved = false;
  try { localStorage.removeItem('xh-park'); } catch(e){}   // roam by default; drag-to-sit is session-only

  function paint(){ el.style.transform = 'translate('+x.toFixed(1)+'px,'+(y-jumpY).toFixed(1)+'px)'; sprite.style.transform = 'scaleX('+face+')'; }
  function cx(){ return x + w()/2; }
  function cy(){ return y + h()/2; }
  function clampX(v){ return Math.max(0, Math.min(innerWidth-w(), v)); }
  function clampY(v){ return Math.max(0, Math.min(innerHeight-h(), v)); }
  function look(px){ el.style.setProperty('--xh-look', Math.max(-2.6,Math.min(2.6,(px-cx())/110))*face + 'px'); }
  function lerp(a,b,k){ return a+(b-a)*k; }
  function jump(hh){ if (jT0<0){ jT0=performance.now(); jH=hh||20; } }

  function glyph(txt, cls){
    var s = document.createElement('span'); s.className = 'xh-glyph' + (cls?' '+cls:''); s.textContent = txt;
    s.style.left = (cx()-6)+'px'; s.style.top = (y-jumpY-6)+'px';
    s.style.setProperty('--dx', (Math.random()*30-15|0)+'px'); s.style.setProperty('--rot', (Math.random()*40-20|0)+'deg');
    fx.appendChild(s); s.addEventListener('animationend', function(){ s.remove(); });
  }
  function dust(px, py){ for (var i=0;i<3;i++){ var d=document.createElement('span'); d.className='xh-glyph xh-dust'; d.style.left=((px!=null?px:cx()-face*10)+(Math.random()*8-4))+'px'; d.style.top=((py!=null?py:y+h()-8))+'px'; d.style.setProperty('--dx',(-face*(8+Math.random()*16)|0)+'px'); fx.appendChild(d); d.addEventListener('animationend', function(){ this.remove(); }); } }
  function crumb(){ var d=document.createElement('span'); d.className='xh-glyph xh-dust'; d.style.left=cx()+'px'; d.style.top=(y+h()*0.52)+'px'; d.style.setProperty('--dx',(Math.random()*22-11|0)+'px'); fx.appendChild(d); d.addEventListener('animationend', function(){ this.remove(); }); }

  // thoughts harvested from THIS page's content
  var pool = null;
  function buildPool(){
    var out = [], seen = {}, root = document.querySelector('main') || document.body;
    var els = root.querySelectorAll('h2,h3,h4,p,li,strong,em,a,td,blockquote,figcaption');
    for (var i=0;i<els.length;i++){
      var e = els[i]; if (e.closest && e.closest('#xiaohei,#xh-fx,.table-of-content,pre,code')) continue;
      var ws = (e.textContent||'').match(/[A-Za-z][A-Za-z'’\-]{3,13}/g); if (!ws) continue;
      for (var j=0;j<ws.length;j++){ var k=ws[j].toLowerCase(); if (!seen[k]){ seen[k]=1; out.push(ws[j]); } }
    }
    return out;
  }
  function thought(){ if (!pool || !pool.length) pool = buildPool(); return pool.length ? pool[(Math.random()*pool.length)|0] : ['?','…','!'][(Math.random()*3)|0]; }

  function emptyTarget(){
    var cw = Math.min(innerWidth-32, 800), gut = (innerWidth-cw)/2, cwd = w(), yTop = 48, yBot = innerHeight-h()-8;
    if (yBot < yTop) return null;
    var zones = [];
    if (gut >= cwd+12){ zones.push([4, gut-cwd-4]); zones.push([innerWidth-gut+4, innerWidth-cwd-6]); }
    if (!zones.length) return null;
    var z = zones[(Math.random()*zones.length)|0];
    return { x: z[0] + Math.random()*Math.max(1,(z[1]-z[0])), y: yTop + Math.random()*(yBot-yTop) };
  }

  /* ── pick a real word for juggle/eat/ponder ── */
  function pickWord(){
    var root = document.querySelector('main') || document.body;
    var wk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode:function(n){
      if (!n.nodeValue || !/[A-Za-z]/.test(n.nodeValue)) return 2;
      var p = n.parentNode; if (!p || !p.closest) return 2;
      if (p.closest('script,style,code,pre,nav,.table-of-content,#xiaohei,#xh-fx,h1')) return 2;
      return 1;
    }});
    var nodes = [], n; while (n = wk.nextNode()){ nodes.push(n); }
    for (var t=0; t<30 && nodes.length; t++){
      var nd = nodes[(Math.random()*nodes.length)|0], txt = nd.nodeValue, ms = [], m, re = /[A-Za-z][A-Za-z'’\-]{2,11}/g;
      while (m = re.exec(txt)) ms.push(m);
      if (!ms.length) continue;
      var mm = ms[(Math.random()*ms.length)|0];
      var rg = document.createRange(); rg.setStart(nd, mm.index); rg.setEnd(nd, mm.index+mm[0].length);
      var r = rg.getBoundingClientRect();
      if (r.width<8 || r.top<72 || r.top>innerHeight-96 || r.left<2 || r.right>innerWidth-2) continue;
      return { node:nd, s:mm.index, e:mm.index+mm[0].length, rect:r };
    }
    return null;
  }
  function cleanupWord(){
    if (!word) return;
    try { if (word.clone) word.clone.remove(); } catch(e){}
    try { if (word.span && word.span.parentNode){ var p = word.span.parentNode; p.replaceChild(document.createTextNode(word.span.textContent), word.span); p.normalize(); } } catch(e){}
    word = null;
  }
  function playWord(){
    var pk = pickWord();
    if (!pk){ setState('walk', 2000); return; }
    var span;
    try { var rg = document.createRange(); rg.setStart(pk.node, pk.s); rg.setEnd(pk.node, pk.e); span = document.createElement('span'); rg.surroundContents(span); }
    catch(e){ setState('walk', 1500); return; }
    var cs = getComputedStyle(span.parentNode), r = span.getBoundingClientRect();
    span.style.visibility = 'hidden';
    var clone = document.createElement('div'); clone.className = 'xh-word'; clone.textContent = span.textContent;
    clone.style.font = cs.fontStyle+' '+cs.fontWeight+' '+cs.fontSize+'/'+cs.lineHeight+' '+cs.fontFamily;
    clone.style.letterSpacing = cs.letterSpacing; clone.style.color = cs.color;
    fx.appendChild(clone);
    var mode = ['juggle','eat','ponder'][(Math.random()*3)|0];
    word = { span:span, clone:clone, ww:r.width, wh:r.height, wx:r.left, wy:r.top, wvy:0, spin:0, vspin:(Math.random()*2-1)*180,
             mode:mode, phase:'reach', bounces:2+(Math.random()*3|0), sc:1, op:1, k0:0, fx:r.left, fy:r.top, guard:performance.now()+8000 };
    paintWord();
    var pt = { x: clampX(r.left+r.width/2-w()/2), y: clampY(r.bottom - h()*0.42) };
    gotoThen(pt, 'play', 99999);
  }
  function paintWord(){ if (word){ word.clone.style.opacity = word.op; word.clone.style.transform = 'translate('+word.wx.toFixed(1)+'px,'+word.wy.toFixed(1)+'px) rotate('+word.spin.toFixed(1)+'deg) scale('+word.sc.toFixed(3)+')'; } }
  function tossV(){ return Math.sqrt(2*G*(80+Math.random()*90)); }
  function socketRect(){ try { return word.span.getBoundingClientRect(); } catch(e){ return null; } }
  function endPlay(){ cleanupWord(); nextBehaviour(); }

  function juggleTick(now, dt){
    var hx = cx()-word.ww/2, hy = y+h()*0.40-word.wh/2;
    if (word.phase==='reach'){
      var k = Math.min(1,(now-word.k0)/300); word.wx=lerp(word.fx,hx,k); word.wy=lerp(word.fy,hy,k); look(word.wx+word.ww/2);
      if (k>=1){ word.phase='juggle'; word.wvy=-tossV(); }
    } else if (word.phase==='juggle'){
      word.wvy+=G*dt; word.wy+=word.wvy*dt; word.wx+=(hx-word.wx)*Math.min(1,dt*7); word.spin+=word.vspin*dt; look(word.wx+word.ww/2);
      if (word.wy>=hy && word.wvy>0){ word.wy=hy;
        if (word.bounces>0){ word.bounces--; word.wvy=-tossV(); word.vspin=(Math.random()*2-1)*180; jump(9); }
        else { word.phase='return'; word.k0=now; word.fx=word.wx; word.fy=word.wy; } }
    } else { returnWord(now, false); }
  }
  function eatTick(now, dt){
    var mcx = cx()-word.ww/2, mcy = y+h()*0.44-word.wh/2;
    if (word.phase==='reach'){
      var k=Math.min(1,(now-word.k0)/360); word.wx=lerp(word.fx,mcx,k); word.wy=lerp(word.fy,mcy-12,k); look(word.wx+word.ww/2);
      if (k>=1){ word.phase='chomp'; word.k0=now; word.fx=word.wx; word.fy=word.wy; }
    } else if (word.phase==='chomp'){
      var k=Math.min(1,(now-word.k0)/420); word.wx=lerp(word.fx,mcx,k); word.wy=lerp(word.fy,mcy,k); word.sc=1-0.9*k; word.op=1-0.45*k; word.spin+=160*dt;
      if (Math.random()<dt*12) crumb();
      if (k>=1){ word.phase='gulp'; word.k0=now; word.sc=0.1; word.op=0.3; el.classList.remove('xh-eat'); jump(8); glyph('nom'); }
    } else if (word.phase==='gulp'){
      if (now-word.k0>320){ word.phase='return'; word.k0=now; word.fx=mcx; word.fy=mcy; el.classList.add('xh-eat'); }
    } else { returnWord(now, true); }
  }
  function ponderTick(now, dt){
    var hx = cx()-word.ww/2, hy = y-word.wh-6;
    if (word.phase==='reach'){
      var k=Math.min(1,(now-word.k0)/360); word.wx=lerp(word.fx,hx,k); word.wy=lerp(word.fy,hy,k); look(word.wx+word.ww/2);
      if (k>=1){ word.phase='hold'; word.k0=now; el.classList.add('xh-think'); }
    } else if (word.phase==='hold'){
      word.wx+=(hx-word.wx)*Math.min(1,dt*6); word.wy+=(hy-word.wy)*Math.min(1,dt*6); word.spin=Math.sin(now/500)*6; look(word.wx+word.ww/2);
      if (now>brainAt){ glyph(thought()); brainAt=now+520+Math.random()*520; }
      if (now-word.k0 > 2200+Math.random()*1200){ el.classList.remove('xh-think'); word.phase='return'; word.k0=now; word.fx=word.wx; word.fy=word.wy; }
    } else { returnWord(now, false); }
  }
  function returnWord(now, grow){
    var sr = socketRect(); if (!sr){ endPlay(); return; }
    var k = Math.min(1,(now-word.k0)/470);
    var arc = grow ? Math.sin(k*Math.PI)*34 : 0;
    word.wx = lerp(word.fx, sr.left, k); word.wy = lerp(word.fy, sr.top, k) - arc; word.spin *= (1-k);
    if (grow){ word.sc = lerp(0.1,1,Math.min(1,k*1.5)); word.op = lerp(0.3,1,Math.min(1,k*1.5)); }
    if (k>=1){ if (grow) el.classList.remove('xh-eat'); endPlay(); }
  }

  /* ── GEAR-5 RUBBER RUN: sprint a text line, plow its words into a pile ── */
  function pickLine(){
    var root = document.querySelector('main') || document.body;
    var els = root.querySelectorAll('h2,h3,h4,li,p,blockquote,figcaption');
    var cand = [];
    for (var i=0;i<els.length;i++){
      var e = els[i];
      if (e.children.length) continue;                              // text-only (no inline markup) for safe wrapping
      if (e.closest('.table-of-content,#xiaohei,#xh-fx,pre,code')) continue;
      var r = e.getBoundingClientRect();
      var fs = parseFloat(getComputedStyle(e).fontSize) || 16;
      var words = (e.textContent||'').trim().split(/\s+/);
      if (words.length < 3 || words.length > 16) continue;
      if (r.top < 80 || r.top > innerHeight-130) continue;          // comfortably in view
      if (r.height > fs*2.2) continue;                              // single visual line
      if (r.width < 120) continue;
      cand.push(e);
    }
    return cand.length ? cand[(Math.random()*cand.length)|0] : null;
  }
  function wrapWords(e){
    var text = e.textContent; e.setAttribute('data-xh', '1'); e.__xh = text;
    var origH = e.getBoundingClientRect().height;
    e.textContent = '';
    var parts = text.split(/(\s+)/), spans = [];
    for (var i=0;i<parts.length;i++){
      if (parts[i]==='') continue;
      if (/^\s+$/.test(parts[i])) e.appendChild(document.createTextNode(parts[i]));
      else { var s=document.createElement('span'); s.className='xh-w'; s.textContent=parts[i]; e.appendChild(s); spans.push(s); }
    }
    if (e.getBoundingClientRect().height > origH*1.7){ e.textContent = text; delete e.__xh; e.removeAttribute('data-xh'); return null; } // wrapping changed layout -> abort
    return spans;
  }
  function restoreLine(){ if (line && line.starsEl){ try { line.starsEl.remove(); } catch(e){} } if (line && line.el && line.el.__xh!=null){ line.el.textContent = line.el.__xh; delete line.el.__xh; line.el.removeAttribute('data-xh'); } line = null; }
  function startRubber(){
    var e = pickLine(); if (!e){ setState('walk', 1800); return; }
    var spans = wrapWords(e); if (!spans){ setState('walk', 1500); return; }
    var er = e.getBoundingClientRect(), words = [], top = 1e9, left = 1e9, right = 0;
    for (var i=0;i<spans.length;i++){ var r=spans[i].getBoundingClientRect(); words.push({ span:spans[i], ox:r.left, w:r.width, piled:false }); if (r.top<top) top=r.top; if (r.left<left) left=r.left; if (r.right>right) right=r.right; }
    var dir = Math.random()<0.5 ? 1 : -1;                              // run left OR right
    var plantX = dir>0 ? clampX(left - w()*0.4) : clampX(right - w()*0.6);
    line = { el:e, words:words, dir:dir, leftEdge:6, rightEdge:innerWidth-6, plantX:plantX, wallX: dir>0 ? (innerWidth - w() - 8) : 2, lineTop:top, maxScroll:(right-left)+innerWidth*0.6+170, churnDur:1500, phase:'churn', t0:0, vbx:0, starsEl:null, guard:performance.now()+11000 };
    for (var si=0; si<spans.length; si++) spans[si].style.transition='none';
    gotoThen({x:plantX, y:clampY(top - h() + 8)}, 'rubber', 99999);
  }
  function layoutChurn(sc){ if (!line) return 0; var used=0, remaining=0, i, wd;
    if (line.dir>0){ for (i=0;i<line.words.length;i++){ wd=line.words[i]; var nat=wd.ox - sc, slot=line.leftEdge+used, tgt=nat>slot?nat:slot; if (nat>slot+0.5) remaining++; wd.span.style.transform='translateX('+(tgt-wd.ox).toFixed(1)+'px)'; used+=wd.w*0.5; } }
    else { for (i=0;i<line.words.length;i++){ wd=line.words[i]; var n2=wd.ox + sc, s2=line.rightEdge - used - wd.w, t2=n2<s2?n2:s2; if (n2<s2-0.5) remaining++; wd.span.style.transform='translateX('+(t2-wd.ox).toFixed(1)+'px)'; used+=wd.w*0.5; } }
    return remaining; }
  function spawnStars(){ var d=document.createElement('div'); d.className='xh-stars'; for (var i=0;i<4;i++){ var s=document.createElement('span'); s.className='s'; s.textContent='★'; s.style.transform='rotate('+(i*90)+'deg) translate(0,-16px)'; d.appendChild(s); } fx.appendChild(d); return d; }
  function loveYou(){ if (reduce || innerWidth<=768 || dragging) return; setState('love', 3400); glyph('love you'); brainAt = performance.now() + 700; }
  function posBanner(){ if (bannerEl){ bannerEl.style.left = cx()+'px'; bannerEl.style.top = (y - jumpY - 4)+'px'; } }
  function showBanner(){ if (reduce || innerWidth<=768 || dragging) return; setState('banner', 6500); bannerEl = document.createElement('div'); bannerEl.className='xh-banner-sign'; bannerEl.innerHTML='Thanks for reading! <span class="hh">❤</span><br>share feedback'; fx.appendChild(bannerEl); posBanner(); }
  function posStars(){ if (line && line.starsEl){ line.starsEl.style.left = cx()+'px'; line.starsEl.style.top = (y - jumpY - 12)+'px'; } }
  function rubberTick(now, dt){
    if (!line){ setState('walk', 1200); return; }
    if (now > line.guard){ for (var g=0;g<line.words.length;g++){ line.words[g].span.style.transition=''; line.words[g].span.style.transform=''; } restoreLine(); setState('walk', 1200); return; }
    if (line.phase==='churn'){                                       // stands on the line, runs in place; all words pile up BEHIND him
      if (!line.t0) line.t0 = now;
      var k = Math.min(1,(now-line.t0)/line.churnDur), sc = (1-Math.pow(1-k,3))*line.maxScroll;
      x = clampX(line.plantX + Math.sin(now*0.05)*2); y = clampY(line.lineTop - h() + 8); face = line.dir;
      var remaining = layoutChurn(sc);
      if (Math.random() < dt*16) dust(x - w()*0.35, y + h() - 6);
      if (remaining===0 || k>=1){ line.phase='rocket'; line.t0=now; line.vbx=line.dir*2300; el.classList.remove('xh-lean');
        for (var i=0;i<line.words.length;i++){ var s=line.words[i].span; s.style.transition=''; s.style.transform=''; }   // ground snaps back -> launches him like a rocket
        dust(x - w()*0.5, y + h()*0.5); }
    } else if (line.phase==='rocket'){                               // shoots himself forward
      x += line.vbx*dt; face = line.dir;
      if (Math.random() < dt*30) dust(x - line.dir*w()*0.5, y + h()*0.4);
      var hit = line.dir>0 ? (x + w() >= line.wallX) : (x <= line.wallX);
      if (hit){ x = line.wallX; line.phase='spring'; line.t0=now; line.vbx = -line.dir*820; el.classList.add('xh-bonk'); dust(x+w()*0.5, y+h()*0.4); line.starsEl = spawnStars(); }
    } else if (line.phase==='spring'){                               // hits the end, springs against the wall (damped)
      var ax = (line.wallX - x)*34 - line.vbx*7; line.vbx += ax*dt; x += line.vbx*dt;
      posStars();
      if (Math.abs(line.vbx) < 45 && Math.abs(line.wallX - x) < 3){ x = line.wallX; line.phase='getup'; line.t0=now; el.classList.remove('xh-bonk'); }
    } else if (line.phase==='getup'){                                // sees stars, then gets up
      posStars();
      if (now-line.t0 > 950){ if (line.starsEl){ line.starsEl.remove(); line.starsEl=null; } jump(10); restoreLine(); nextBehaviour(); }
    }
  }

  (function blink(){ if (state!=='sleep' && state!=='yawn'){ el.classList.add('xh-blink'); setTimeout(function(){ el.classList.remove('xh-blink'); }, 130); } setTimeout(blink, 2400+Math.random()*3600); })();

  if (!reduce) addEventListener('mousemove', function(e){
    if (state!=='play' && state!=='rubber' && !dragging) look(e.clientX);
    if (state==='sleep' && Math.hypot(e.clientX-cx(), e.clientY-cy())<150) nextBehaviour();
  }, {passive:true});

  /* ── drag to pick up & place ── */
  sprite.addEventListener('pointerdown', function(e){
    if (reduce) return; e.preventDefault();
    dragging=true; moved=false; downX=e.clientX; downY=e.clientY; ddx=e.clientX-x; ddy=e.clientY-y;
    if (state==='play') cleanupWord(); if (state==='rubber') restoreLine();
    state='held'; clearPose(); el.classList.add('xh-held');
    try { sprite.setPointerCapture(e.pointerId); } catch(err){}
  });
  sprite.addEventListener('pointermove', function(e){
    if (!dragging) return;
    if (Math.hypot(e.clientX-downX, e.clientY-downY) > 4) moved=true;
    x=clampX(e.clientX-ddx); y=clampY(e.clientY-ddy); paint();
  });
  function drop(e){
    if (!dragging) return; dragging=false; el.classList.remove('xh-held');
    try { sprite.releasePointerCapture(e.pointerId); } catch(err){}
    if (moved){ parked=true; jump(8); }
    nextBehaviour();
  }
  sprite.addEventListener('pointerup', drop);
  sprite.addEventListener('pointercancel', drop);
  sprite.addEventListener('dblclick', function(){ parked=!parked; glyph(parked?'📌':'🏃'); nextBehaviour(); });
  addEventListener('resize', function(){ x=clampX(x); y=clampY(y); paint(); }, {passive:true});

  function clearPose(){ el.classList.remove('xh-walk','xh-run','xh-inspect','xh-yawn','xh-sleep','xh-think','xh-play','xh-eat','xh-air','xh-lean','xh-bonk','xh-love','xh-banner'); }
  function setState(s, dur){
    var keepW = (s==='play') || (s==='goto' && pend && pend.s==='play');
    var keepL = (s==='rubber') || (s==='goto' && pend && pend.s==='rubber');
    if (word && !keepW) cleanupWord();          // always restore an orphaned word/line on any state change
    if (line && !keepL) restoreLine();
    if (bannerEl && s!=='banner'){ bannerEl.remove(); bannerEl=null; }
    state = s; clearPose(); until = performance.now()+(dur||3000);
    if (s==='walk'){ el.classList.add('xh-walk'); heading=Math.random()*6.28; turnRate=(Math.random()-.5)*2; speed=30+Math.random()*18; }
    else if (s==='dash'){ el.classList.add('xh-walk','xh-run'); var b=Math.random()*6.28; vx=Math.cos(b)*150; vy=Math.sin(b)*72; }
    else if (s==='goto'){ el.classList.add('xh-walk'); }
    else if (s==='rubber'){ el.classList.add('xh-walk','xh-run','xh-lean'); }
    else if (s==='play'){ el.classList.add(word && word.mode==='eat' ? 'xh-eat' : word && word.mode==='ponder' ? 'xh-think' : 'xh-play'); }
    else { vx=0; vy=0; if (s==='inspect') el.classList.add('xh-inspect'); else if (s==='yawn') el.classList.add('xh-yawn'); else if (s==='sleep') el.classList.add('xh-sleep'); else if (s==='think') el.classList.add('xh-think'); else if (s==='love') el.classList.add('xh-love'); else if (s==='banner') el.classList.add('xh-banner'); }
  }
  function gotoThen(pt, anticName, dur){ pend = {s:anticName, d:dur}; tx=pt.x; ty=pt.y; setState('goto', 9000); }
  function antic(name, dur){ var t = parked ? null : emptyTarget(); if (t) gotoThen(t, name, dur); else setState(name, dur); }

  function nextBehaviour(){
    if (dragging) return;
    if (parked){
      var r0 = Math.random();
      if (r0<0.4) setState('think', 1800+Math.random()*1400);
      else if (r0<0.66) setState('rest', 1500+Math.random()*1800);
      else if (r0<0.85) setState('yawn', 1500);
      else setState('sleep', 3500+Math.random()*3500);
      return;
    }
    var r = Math.random();
    if (r<0.32) setState('walk', 2600+Math.random()*3000);
    else if (r<0.44) setState('dash', 500+Math.random()*350);
    else if (r<0.70) playWord();
    else if (r<0.80) startRubber();
    else if (r<0.89) antic('inspect', 2600+Math.random()*1800);
    else if (r<0.95) antic('think', 1800+Math.random()*1400);
    else if (r<0.98) antic('yawn', 1500);
    else antic('sleep', 3000+Math.random()*3000);
  }

  function fireHash(delay){                                  // map URL hash -> trigger (runs at load AND on live hashchange)
    if (reduce || innerWidth <= 768) return;
    var d = delay || 0, hsh = location.hash;
    if (hsh === '#play') setTimeout(playWord, d);
    else if (hsh === '#love') setTimeout(loveYou, d);
    else if (hsh === '#banner') setTimeout(showBanner, d);
    else if (hsh === '#gear5' || hsh === '#rubber') setTimeout(startRubber, d);
  }
  fireHash(600);
  addEventListener('hashchange', function(){ fireHash(0); });
  if (reduce){ paint(); return; }
  if (parked) nextBehaviour(); else setState('walk', 3000);
  setInterval(loveYou, 21000);          // say "love you" every 21s
  setTimeout(showBanner, 120000);       // at 2 min: hold a thanks-for-reading banner
  addEventListener('pagehide', function(){ if (word) cleanupWord(); if (line) restoreLine(); });   // never leave text broken
  var last = performance.now();
  function tick(now){
    var dt = Math.min(0.05,(now-last)/1000); last = now;
    if (innerWidth <= 768){ if (word) cleanupWord(); if (line) restoreLine(); requestAnimationFrame(tick); return; }   // disabled on mobile
    if (jT0>=0){ var jp=(now-jT0)/jDur; if (jp>=1){ jumpY=0; jT0=-1; el.classList.remove('xh-air'); } else { jumpY=Math.sin(jp*Math.PI)*jH; if (jumpY>5) el.classList.add('xh-air'); else el.classList.remove('xh-air'); } }

    if (state==='walk'){
      turnRate += (Math.random()-0.5)*11*dt;
      if (Math.random() < dt*0.9) turnRate = -(turnRate>=0?1:-1)*(1.6+Math.random()*2.6);
      turnRate = Math.max(-3.4, Math.min(3.4, turnRate));
      heading += turnRate*dt;
      var cw=Math.min(innerWidth-32,800), cl=(innerWidth-cw)/2, cr=innerWidth-cl;
      if (cx()>cl && cx()<cr && cr-cl < innerWidth-40){ var want = cx()<innerWidth/2 ? Math.PI : 0; var dd=Math.atan2(Math.sin(want-heading),Math.cos(want-heading)); heading += dd*Math.min(1,dt*1.1); }
      vx = Math.cos(heading)*speed; vy = Math.sin(heading)*speed*0.7;
      x += vx*dt; y += vy*dt;
      var mX=innerWidth-w(), mY=innerHeight-h();
      if (x<=0){ x=0; heading=Math.PI-heading; } else if (x>=mX){ x=mX; heading=Math.PI-heading; }
      if (y<=0){ y=0; heading=-heading; } else if (y>=mY){ y=mY; heading=-heading; }
      face = Math.cos(heading)>=0 ? 1 : -1;
      if (jT0<0 && Math.random() < dt*0.4) jump(16+Math.random()*16);
    } else if (state==='dash'){
      x += vx*dt; y += vy*dt;
      var dX=innerWidth-w(), dY=innerHeight-h();
      if (x<=0){ x=0; vx=Math.abs(vx); } else if (x>=dX){ x=dX; vx=-Math.abs(vx); }
      if (y<=0){ y=0; vy=Math.abs(vy); } else if (y>=dY){ y=dY; vy=-Math.abs(vy); }
      if (vx>3) face=1; else if (vx<-3) face=-1;
      if (Math.random()<dt*8) dust();
    } else if (state==='goto'){
      var gx=tx-x, gy=ty-y, gd=Math.hypot(gx,gy);
      if (gd<6){ if (pend){ var p=pend; pend=null; setState(p.s, p.d); } else nextBehaviour(); }
      else { var gs=(pend&&pend.s==='rubber')?400:110; var sp=Math.min(gd, gs*dt); x+=gx/gd*sp; y+=gy/gd*sp; if (gx>2) face=1; else if (gx<-2) face=-1; }
    } else if (state==='play' && word){
      if (now > word.guard){ setState('walk', 1500); }
      else if (word.mode==='eat') eatTick(now, dt);
      else if (word.mode==='ponder') ponderTick(now, dt);
      else juggleTick(now, dt);
      paintWord();
    } else if (state==='rubber'){
      rubberTick(now, dt);
    }

    if (state==='think' && now>brainAt){ glyph(thought()); brainAt = now+480+Math.random()*520; }
    if (state==='love' && now>brainAt){ glyph('love you'); brainAt = now+700+Math.random()*400; }
    if (state==='banner') posBanner();
    if (state==='inspect'){ if (now>brainAt){ glyph(thought()); brainAt = now+650+Math.random()*600; } el.style.setProperty('--xh-look', (Math.sin(now/300)*2.2).toFixed(2)+'px'); }
    if (state==='sleep' && now>brainAt){ glyph('z','xh-z'); brainAt = now+900+Math.random()*500; }
    if (state!=='goto' && state!=='play' && state!=='rubber' && state!=='held' && now>until){ if (state==='yawn' && !parked && Math.random()<0.3) setState('sleep', 4000+Math.random()*3000); else nextBehaviour(); }
    paint(); requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
