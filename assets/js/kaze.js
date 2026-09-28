/* Kaze (風) — a free, rubbery wind-spirit. WebGL SDF renderer + tiny physics.
   Coordinates are CSS px, y down. Character-local units are scaled by S. */
(() => {
  'use strict';
  if (window.__kaze) return; window.__kaze = true;
  const root = document.getElementById('kaze');
  if (!root) return;
  const canvas = root.querySelector('canvas');
  const hit = root.querySelector('.kz-hit');
  const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const IS_ARTICLE = root.dataset.article === '1';
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) { root.remove(); return; }

  /* ───────────────────────── utils ───────────────────────── */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, k) => a + (b - a) * k;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[(Math.random() * a.length) | 0];
  const now = () => performance.now();
  const sgn = (v) => (v < 0 ? -1 : 1);
  const hyp = Math.hypot;

  let W = innerWidth, H = innerHeight, DPR = Math.min(2, devicePixelRatio || 1);
  const MOBILE = () => W <= 768;
  let S0 = MOBILE() ? 0.8 : 1.15, S = S0;   // character scale (S = S0 × gear scale)
  /* gear visuals: current (GV) eased toward target (GT) every frame */
  const GV = { tint: 0, tr: 1, tg: 1, tb: 1, hair: 0, g5: 0, pop: 0, bulk: 0, gs: 1, a0: 2.1, h0: 3.1, a1: 2.1, h1: 3.1 };
  const GT = Object.assign({}, GV);
  function gearReset() { Object.assign(GT, { tint: 0, hair: 0, g5: 0, pop: 0, bulk: 0, gs: 1, a0: 2.1, h0: 3.1, a1: 2.1, h1: 3.1 }); }
  function gearTint(r, g, b, a) { GT.tr = GV.tr = r; GT.tg = GV.tg = g; GT.tb = GV.tb = b; GT.tint = a; }
  const queue = [];
  let auraT = 0, auraA = 0, auraP = 0;             // meditation sphere: target, amount, pulse
  const G = 2300;                          // gravity px/s²
  const FOOT = 25.5, SEAT = 19.5;              // local: feet / bottom below body centre

  /* ───────────────────────── colours (theme-aware) ───────────────────────── */
  const c2d = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  c2d.canvas.width = c2d.canvas.height = 1;
  function parseColor(str, fb) {
    str = (str || '').trim(); if (!str) return fb;
    c2d.clearRect(0, 0, 1, 1); c2d.fillStyle = '#010203'; c2d.fillStyle = str; c2d.fillRect(0, 0, 1, 1);
    const d = c2d.getImageData(0, 0, 1, 1).data;
    if (d[3] === 0 || (d[0] === 1 && d[1] === 2 && d[2] === 3)) return fb;
    return [d[0] / 255, d[1] / 255, d[2] / 255];
  }
  let INK = [0.11, 0.1, 0.09], PAPER = [1, 1, 1], RED = [0.91, 0.27, 0.24];
  function readColors() {
    const cs = getComputedStyle(document.body);
    INK = parseColor(cs.getPropertyValue('--article-text'), parseColor(cs.color, INK));
    PAPER = parseColor(cs.getPropertyValue('--article-bg'), parseColor(cs.backgroundColor, PAPER));
    RED = [0.91, 0.27, 0.24];
    const dr = hyp(RED[0] - PAPER[0], RED[1] - PAPER[1], RED[2] - PAPER[2]);
    if (dr < 0.45) RED = [0.98, 0.78, 0.2];          // red page? wear a gold scarf
  }
  readColors();
  new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-force-dark', 'class'] });
  new MutationObserver(readColors).observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });

  /* ───────────────────────── WebGL SDF renderer ───────────────────────── */
  const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  const PREC = hp && hp.precision > 0 ? 'highp' : 'mediump';
  const VS = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
  const FS = `precision ${PREC} float;
uniform vec2 uRes; uniform float uDpr, uS, uSeed;
uniform vec3 uInk, uPaper, uRed;
uniform vec4 uBody, uSq, uEye, uMouth, uHat, uShadow, uMisc, uTint, uGear, uArmR, uAura;
uniform vec2 uA0[7]; uniform vec2 uA1[7]; uniform vec2 uSc[8];
uniform vec4 uLeg[2];
float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x), mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x), f.y); }
vec2 rotv(vec2 v, float a){ float c=cos(a), s=sin(a); return vec2(c*v.x-s*v.y, s*v.x+c*v.y); }
float sdSeg(vec2 p, vec2 a, vec2 b){ vec2 pa=p-a, ba=b-a; float h=clamp(dot(pa,ba)/max(dot(ba,ba),1e-4),0.,1.); return length(pa-ba*h); }
float smin(float a, float b, float k){ float h=clamp(.5+.5*(b-a)/k,0.,1.); return mix(b,a,h)-k*h*(1.-h); }
float sdBox(vec2 p, vec2 b){ vec2 d=abs(p)-b; return length(max(d,0.))+min(max(d.x,d.y),0.); }
float sdTri(vec2 p, vec2 p0, vec2 p1, vec2 p2){
  vec2 e0=p1-p0, e1=p2-p1, e2=p0-p2; vec2 v0=p-p0, v1=p-p1, v2=p-p2;
  vec2 q0=v0-e0*clamp(dot(v0,e0)/dot(e0,e0),0.,1.);
  vec2 q1=v1-e1*clamp(dot(v1,e1)/dot(e1,e1),0.,1.);
  vec2 q2=v2-e2*clamp(dot(v2,e2)/dot(e2,e2),0.,1.);
  float s=sign(e0.x*e2.y-e0.y*e2.x);
  vec2 d=min(min(vec2(dot(q0,q0), s*(v0.x*e0.y-v0.y*e0.x)), vec2(dot(q1,q1), s*(v1.x*e1.y-v1.y*e1.x))), vec2(dot(q2,q2), s*(v2.x*e2.y-v2.y*e2.x)));
  return -sqrt(d.x)*sign(d.y);
}
float sdEll(vec2 p, vec2 r){ float k0=length(p/r), k1=length(p/(r*r)); return k0*(k0-1.)/max(k1,1e-4); }
float cov(float d){ return clamp(.5-d*uDpr, 0., 1.); }
vec4 over(vec4 dst, vec3 c, float a){ return vec4(c*a, a) + dst*(1.-a); }
float sdTaper(vec2 p, vec2 a, vec2 b, float r0, float r1){ vec2 pa=p-a, ba=b-a; float h=clamp(dot(pa,ba)/max(dot(ba,ba),1e-4),0.,1.); return length(pa-ba*h)-mix(r0,r1,h); }
/* gear 5 mane (super-saiyan volume): a big rounded dome on the head, flame spikes curling up around
   its silhouette, jagged bangs, bold swirl curls inside, grey cel-shading underneath */
float spiralLine(vec2 v, float R, float t){ float r=length(v); float th=fract(atan(v.y,v.x)/6.2832+.5+t); float s=R*.6; float u=r/s-th; float d=(.5-abs(fract(u)-.5))*s; return max(d-.42, r-R); }
float spiralShade(vec2 v, float R, float t){ float r=length(v); float th=fract(atan(v.y,v.x)/6.2832+.5+t); float s=R*.6; float f=fract(r/s-th); return smoothstep(.05,.11,f)*smoothstep(.46,.4,f)*step(r,R); }
float flame(vec2 q, vec2 b, float a, float len, float w, float bend){
  vec2 dr=vec2(sin(a),-cos(a)), nr=vec2(-dr.y,dr.x);
  vec2 m=b+dr*len*.5+nr*bend*len*.18, tp=b+dr*len+nr*bend*len*.45;
  return min(sdTaper(q,b,m,w,w*.5), sdTaper(q,m,tp,w*.5,.12));
}
vec4 hairL(vec2 q, float amt, float t, float face){
  vec2 c=vec2(-face*1.2,-22.);
  float d=smin(sdEll(q-c, vec2(18.,13.)*amt), sdEll(q-c-vec2(face*3.,-4.)*amt, vec2(13.,11.)*amt), 4.);
  for (int i=0;i<7;i++){
    float fi=float(i)/6., a=mix(-1.45,1.45,fi)+sin(fi*23.)*.12;
    vec2 b=c+vec2(sin(a)*14.,-cos(a)*10.)*amt;
    float len=(12.+7.*fract(sin(fi*57.3)*91.1)+2.*sin(t*5.+fi*9.))*amt;
    float bend=(a<0.?1.:-1.)*(.9+.35*sin(t*3.5+fi*7.));           /* big tongues curling upward like fire */
    d=smin(d, flame(q,b,a*1.05,len,6.2*amt,bend), 2.);
  }
  d=smin(d, flame(q,c+vec2(-17.,6.)*amt,-2.1,9.*amt,4.*amt,.6), 1.4);    /* tufts flaring beside the face */
  d=smin(d, flame(q,c+vec2(17.,6.)*amt,2.1,9.*amt,4.*amt,-.6), 1.4);
  for (int i=0;i<3;i++){ float fi=float(i)/2.; vec2 b=vec2(mix(-12.,12.,fi)-face*1.2,-10.); d=min(d, sdTaper(q,b,b+vec2(mix(1.5,-1.5,fi),4.)*amt,2.8*amt,.2)); }
  vec2 s0=c+vec2(-3.,-2.)*amt, s1=c+vec2(9.,3.)*amt, s2=c+vec2(-12.,5.)*amt;       /* one big curl, two smaller */
  float sl=min(spiralLine(q-s0,7.*amt,t*.04), min(spiralLine(q-s1,4.6*amt,-t*.05), spiralLine(q-s2,3.8*amt,t*.06)));
  float ss=max(spiralShade(q-s0,7.*amt,t*.04), max(spiralShade(q-s1,4.6*amt,-t*.05), spiralShade(q-s2,3.8*amt,t*.06)));
  return vec4(d, sl, ss, 0.);
}
/* straw hat as a layer so it can sit on his head or hang on his back */
vec4 hatLayer(vec2 p){
  vec4 col=vec4(0.);
  float S=uS;
  vec2 h=rotv(p-uHat.xy,-uHat.z)/(S*uHat.w);
  float brim=sdEll(h,vec2(18.,3.5));
  float crown=max(sdEll(h-vec2(0.,-3.4),vec2(9.8,9.4)), h.y+.4);
  float dH=min(brim,crown);
  float dHw=dH*S*uHat.w;
  vec3 straw=vec3(.95,.79,.38);
  float shade=.88+.12*smoothstep(3.4,-3.4,h.y);
  col=over(col, straw*shade, cov(dHw));
  float ring=abs(fract(length(h/vec2(18.,3.5))*4.)-.5);
  float rows=abs(fract(h.y*.55)-.5);
  float wv=brim<0.&&crown>0. ? smoothstep(.12,.0,ring) : (crown<0. ? smoothstep(.1,.0,rows)*.8 : 0.);
  col=over(col, straw*.62, wv*.55*step(dH,0.));
  float band=max(crown+.3, abs(h.y+2.6)-1.9);
  col=over(col, uRed*.95, cov(band*S*uHat.w));
  col=over(col, uInk, cov(abs(dHw)-.55*S));
  col=over(col, uInk, cov((abs(crown)-.45)*S*uHat.w)*step(brim,0.)*.8);
  return col;
}
float bodyL(vec2 q){ return smin(length(q-vec2(0.,-4.5))-12., length(q-vec2(0.,5.))-14.5, 8.); }
void main(){
  vec2 p = vec2(gl_FragCoord.x, uRes.y-gl_FragCoord.y)/uDpr;
  vec2 nz = vec2(vnoise(p*.12+uSeed*7.13), vnoise(p*.12+vec2(19.7,3.3)+uSeed*5.31))-.5;
  p += nz*1.25*uMisc.x;                                   /* hand-drawn line boil */
  float S=uS, face=uBody.w, sx=uSq.x, sy=uSq.y, ms=S*min(sx,sy);
  vec2 q = rotv(p-uBody.xy, -uBody.z)/S; q.x/=sx; q.y=(q.y-19.5)/sy+19.5;
  float dB = bodyL(q)*ms;
  float hairA=uGear.x, g5=uGear.y, gt=uGear.z;
  vec3 WHITE=vec3(.98,.97,.95), LINE=vec3(.12);
  float dL = 1e5;
  for (int i=0;i<6;i++){ dL=min(dL, sdSeg(p,uA0[i],uA0[i+1])-uArmR.x*S); dL=min(dL, sdSeg(p,uA1[i],uA1[i+1])-uArmR.z*S); }
  dL=min(dL, length(p-uA0[6])-uArmR.y*S); dL=min(dL, length(p-uA1[6])-uArmR.w*S);
  for (int i=0;i<2;i++){ dL=min(dL, sdSeg(p,uLeg[i].xy,uLeg[i].zw)-2.4*S); dL=min(dL, length((p-uLeg[i].zw+vec2(0.,.4*S))/vec2(1.3,1.))-2.6*S); }
  float dInk = smin(dB, dL, 2.4*S);
  float dS = 1e5;
  for (int i=0;i<7;i++){ float fi=float(i)/7.; dS=min(dS, sdSeg(p,uSc[i],uSc[i+1])-mix(3.,1.4,fi)*(1.+g5*(.7+.45*sin(fi*17.+gt*3.)))*S); }
  vec2 sp=(p-uShadow.xy)/vec2(uShadow.z, uShadow.z*.2);
  float sh=(1.-smoothstep(.45,1.,length(sp)))*uShadow.w;
  vec4 col=vec4(0.);
  if (uAura.w>.005){                                      /* meditation: a clear, softly-lit sphere */
    float dA=length(p-uAura.xy), rN=dA/uAura.z, inA=cov(dA-uAura.z);
    vec3 glow=vec3(1.,.87,.58);
    col=over(col,glow,(.03+.13*pow(clamp(rN,0.,1.),4.))*inA*uAura.w);         /* nearly clear, brighter toward the rim */
    col=over(col,glow,cov(abs(dA-uAura.z)-.55)*.32*uAura.w);                   /* hairline rim */
    vec2 hp=(p-uAura.xy)/uAura.z-vec2(-.4,-.45);
    col=over(col,vec3(1.),(1.-smoothstep(0.,.2,length(hp*vec2(1.,1.7))))*.2*inA*uAura.w);   /* one small highlight */
  }
  col=over(col,uInk,sh);
  /* sticker halo in the page colour: invisible on the page, separates him from images/code */
  col=over(col,uPaper,cov(min(dInk,dS)-1.3*S)*.9);
  vec3 scC=mix(uRed,WHITE,g5);                           /* gear 5: the scarf becomes cloud */
  col=over(col,scC,cov(dS));
  col=over(col,LINE,cov(abs(dS)-.5*S)*g5);
  if (uMisc.y>.5 && uMisc.z>.5){ vec4 hc=hatLayer(p); col=hc+col*(1.-hc.a); }   /* gear 5: hat hangs on his back */
  col=over(col,mix(uInk,uTint.rgb,uTint.a),cov(dInk));
  col=over(col,LINE,cov(abs(dInk)-.55*S)*g5);
  vec3 eyeC=mix(uPaper,LINE,step(.5,g5));
  /* scarf wrap + knot, clipped to the body */
  float band=max(sdSeg(q,vec2(-15.,7.8),vec2(15.,7.8))-2.5, bodyL(q)-.6);
  float knot=length(q-vec2(face*8.,8.6))-2.8;
  col=over(col,scC,cov(min(band,knot)*ms));
  if (g5>.01){                                            /* cloud collar around the neck + under the arms */
    float dC=1e5;
    for (int i=0;i<5;i++){ float fi=float(i)/4.; dC=smin(dC, length(q-vec2(mix(-15.,15.,fi), 7.2+sin(fi*9.+gt*2.)))-(3.8+.9*sin(fi*13.+gt*3.))*g5, 1.5); }
    dC=smin(dC, length(q-vec2(-14.5,12.5))-3.4*g5, 1.5); dC=smin(dC, length(q-vec2(14.5,12.5))-3.4*g5, 1.5);
    dC*=ms; col=over(col,WHITE,cov(dC)); col=over(col,LINE,cov(abs(dC)-.5*S)*g5);
  }
  if (hairA>.01){                                         /* the mane sits on top of the head */
    vec4 hr=hairL(q,hairA,gt,face); float dHr=hr.x*ms;
    float dUp=hairL(q+vec2(0.,3.6),hairA,gt,face).x*ms;
    col=over(col,WHITE,cov(dHr));
    col=over(col,vec3(.8,.81,.86),cov(max(dHr,-dUp))*.95);          /* grey underside */
    col=over(col,vec3(.8,.81,.86),hr.z*step(dHr,0.)*.9);             /* shade inside each curl */
    col=over(col,LINE,cov(hr.y*ms)*step(dHr,-.3*S));                 /* bold swirl lines */
    col=over(col,LINE,cov(abs(dHr)-.65*S)*min(1.,hairA*2.));          /* ink outline */
  }
  /* face */
  vec2 ec=vec2(face*2.4+uEye.x, -3.6+uEye.y);
  vec2 e1=q-(ec+vec2(-5.1,0.)), e2=q-(ec+vec2(5.1,0.));
  float md=uEye.w, bl=max(uEye.z,.12), dE;
  if (md<.5){ vec2 r=vec2(2.05,2.9*bl); float k=min(r.x,r.y); dE=min((length(e1/r)-1.)*k,(length(e2/r)-1.)*k); }
  else if (md<1.5){ dE=min(max(abs(length(e1-vec2(0.,1.3))-2.3)-.72, e1.y-1.3), max(abs(length(e2-vec2(0.,1.3))-2.3)-.72, e2.y-1.3)); }
  else if (md<2.5){ dE=min(sdSeg(e1,vec2(-2.3,.7),vec2(2.3,.7)), sdSeg(e2,vec2(-2.3,.7),vec2(2.3,.7)))-.72; }
  else if (md<3.5){ dE=min(min(sdSeg(e1,vec2(-2.,-2.1),vec2(1.9,0.)), sdSeg(e1,vec2(1.9,0.),vec2(-2.,2.1))),
               min(sdSeg(e2,vec2(2.,-2.1),vec2(-1.9,0.)), sdSeg(e2,vec2(-1.9,0.),vec2(2.,2.1))))-.72; }
  else { dE=min(max(abs(length(e1-vec2(0.,-1.6))-2.4)-.68, -1.6-e1.y), max(abs(length(e2-vec2(0.,-1.6))-2.4)-.68, -1.6-e2.y)); }
  float dBl=min(length((q-(ec+vec2(-8.4,3.)))/vec2(1.9,1.))-1.25, length((q-(ec+vec2(8.4,3.)))/vec2(1.9,1.))-1.25);
  col=over(col, mix(uRed,vec3(1.,.62,.72),.55), cov(dBl*ms)*uSq.z*.85);
  if (g5>.5 && md<.5){                                   /* gear 5 eyes: white, glowing red pupils with a ring; they can pop */
    float pop=1.+uGear.w; vec2 r=vec2(3.1,3.1*bl)*pop, lk=vec2(uEye.x,uEye.y)*.5; float on=step(.4,bl);
    float dSc=min((length(e1/r)-1.)*min(r.x,r.y), (length(e2/r)-1.)*min(r.x,r.y));
    col=over(col,WHITE,cov(dSc*ms)); col=over(col,LINE,cov((abs(dSc)-.3)*ms));
    col=over(col,vec3(.93,.13,.2),cov((min(length(e1-lk),length(e2-lk))-1.75*pop)*ms)*on);
    col=over(col,vec3(1.,.78,.42),cov((min(abs(length(e1-lk)-1.05*pop),abs(length(e2-lk)-1.05*pop))-.26*pop)*ms)*on*.9);
    col=over(col,WHITE,cov((min(length(e1-lk-vec2(-.5,-.6)*pop),length(e2-lk-vec2(-.5,-.6)*pop))-.45*pop)*ms)*on);
  } else col=over(col,eyeC,cov(dE*ms));
  vec2 m=q-(ec+vec2(0.,5.4)); float mm=uMouth.x, mo=uMouth.y;
  if (mm>.5){
    float dM;
    if (mm<1.5) dM=max(abs(length(m-vec2(0.,-1.4))-2.1)-.62, -1.4-m.y);
    else if (mm<2.5){ float rr=1.3+2.4*mo; dM=max(length(m-vec2(0.,-.8))-rr, -.8-m.y); }
    else if (mm<3.5){ vec2 rr=vec2(1.1+.9*mo, 1.3+1.5*mo); dM=(length(m/rr)-1.)*min(rr.x,rr.y); }
    else { vec2 gm=m-vec2(0.,-1.2); dM=max(sdEll(gm,vec2(6.4,4.9)*(.8+.2*mo)), -gm.y); }   /* huge toothy grin */
    col=over(col, mm>3.5 ? vec3(.22,.07,.09) : eyeC, cov(dM*ms));
    if (mm>3.5){ vec2 gm=m-vec2(0.,-1.2);                /* big grin: dark mouth, white teeth, red tongue */
      float dTe=max(dM, gm.y-1.9); col=over(col,WHITE,cov(dTe*ms));
      col=over(col,LINE,cov(max(min(min(abs(gm.x+2.8),abs(gm.x)),abs(gm.x-2.8))-.22, dTe)*ms)*.8);
      col=over(col,vec3(.93,.35,.38),cov(max(length(gm-vec2(0.,4.6))-2.3,dM)*ms));
      col=over(col,LINE,cov((abs(dM)-.3)*ms)); }
    if (mm>1.5 && mm<2.5 && mo>.25){ float rr=1.3+2.4*mo; float dT=max(length(m-vec2(0.,1.2+1.9*mo))-1.4*mo, max(length(m-vec2(0.,-.8))-rr+.75, -.8-m.y)); col=over(col,uRed,cov(dT*ms)); }
  }
  if (uMisc.y>.5 && uMisc.z<.5){ vec4 hc=hatLayer(p); col=hc+col*(1.-hc.a); }
  gl_FragColor=col;
}`;
  function shader(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  }
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
  } catch (e) { console.warn('[kaze]', e); root.remove(); return; }
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aLoc = gl.getAttribLocation(prog, 'a'); gl.enableVertexAttribArray(aLoc); gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
  const U = {};
  ['uRes', 'uDpr', 'uS', 'uSeed', 'uInk', 'uPaper', 'uRed', 'uBody', 'uSq', 'uEye', 'uMouth', 'uHat', 'uShadow', 'uMisc', 'uTint', 'uGear', 'uArmR', 'uAura', 'uA0', 'uA1', 'uSc', 'uLeg']
    .forEach((n) => { U[n] = gl.getUniformLocation(prog, n) || gl.getUniformLocation(prog, n + '[0]'); });
  const fA0 = new Float32Array(14), fA1 = new Float32Array(14), fSc = new Float32Array(16), fLeg = new Float32Array(8);

  function resize() {
    W = innerWidth; H = innerHeight; DPR = Math.min(2, devicePixelRatio || 1); S0 = MOBILE() ? 0.8 : 1.15; S = S0 * GV.gs;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();

  /* ───────────────────────── character state ───────────────────────── */
  const B = {
    x: 60, y: H - 30, vx: 0, vy: 0, want: 0, rot: 0, rv: 0, sq: 0, sqv: 0,
    face: 1, faceS: 1, mode: 'ground', surf: null, surfDX: 0, sit: 0, sitK: 0, walkPh: 0,
    blink: 1, eye: 0, mouth: 0, mouthO: 0, blush: 0, pose: 'rest', lotus: 0, lev: 0,
    hatRot: 0, hatRv: 0, hatSlide: 0, hatToss: null, hatFree: null, visible: true, bounces: 0,
  };
  let T = 0;                                         // seconds
  let lookAt = null, lookLock = 0;                   // [x,y] | null
  let mouseX = -1, mouseY = -1, lastMouseAt = -1e9, lastScrollAt = -1e9, lastInputAt = now();
  let scrollV = 0, lastSY = scrollY;
  const startedAt = now();

  function l2w(lx, ly) {
    const sq = B.sq, sx = (1 - sq * 0.55) * (1 + 0.28 * GV.bulk), sy = (1 + sq) * (1 + 0.08 * GV.bulk);
    const x = lx * sx, y = (ly - SEAT) * sy + SEAT, c = Math.cos(B.rot), s = Math.sin(B.rot);
    return [B.x + (c * x - s * y) * S, B.y + (s * x + c * y) * S];
  }
  const frontSide = () => (B.faceS >= 0 ? 1 : -1);
  let sink = 12;
  const floorY = () => (MOBILE() ? H + sink * S : H - 3);
  function surfaceY() {
    if (!B.surf) return floorY();
    const r = B.surf.el.getBoundingClientRect();
    return B.surf.line ? r.top : r.top;
  }

  /* ─ rubber arms: verlet chains, 7 points ─ */
  function makeArm(side) {
    const pts = []; for (let i = 0; i < 7; i++) pts.push({ x: B.x, y: B.y, px: B.x, py: B.y });
    return { side, pts, rest: 2.25, mode: 'pose', tgt: null, grip: null, reach: 0, spd: 1800, arc: 1, onGrip: null, load: false, rope: 0, carry: null };
  }
  const arms = [makeArm(-1), makeArm(1)];
  const armFor = (side) => arms[side < 0 ? 0 : 1];
  function poseLocal(a) {
    const s = a.side, fr = s === frontSide(), t = T;
    const walking = B.mode === 'ground' && Math.abs(B.vx) > 8;
    switch (B.pose) {
      case 'up': return [s * 11, -25];
      case 'wide': return [s * 23 + Math.sin(t * 9 + s) * 1.5, -19 + Math.cos(t * 9) * 1.5];
      case 'wave': return fr ? [s * 17 + Math.sin(t * 15) * 4.5, -20 + Math.cos(t * 15) * 2] : [s * 14.5, 13];
      case 'flail': return [s * (18 + Math.sin(t * 19 + s) * 6), -6 + Math.sin(t * 23 + s * 2) * 15];
      case 'hold': return fr ? [s * 13, -30] : [s * 14.5, 12];
      case 'hat': return fr ? [s * 2, -24] : [s * 17, 4 + Math.sin(t * 20) * 3];
      case 'shrug': return [s * 19, -3];
      case 'sleep': return [s * 8.5, 15];
      case 'bite': return fr ? [s * 4, 3] : [s * 14.5, 13];
      case 'giant': return fr ? [s * 17, -32] : [s * 14.5, 12];
      case 'boundman': return [s * 20, 1 + Math.sin(t * 8 + s) * 1.5];
      case 'lotus': return [s * (18.5 + Math.sin(t * 0.9) * 0.6), 12.5 + Math.sin(t * 1.1 + s) * 0.9];
      case 'swing': return [s * 20 + Math.sin(t * 5 + s) * 3, 2 + Math.cos(t * 4) * 5];
      default: {
        const sw = walking ? Math.sin(B.walkPh + (s > 0 ? 0 : Math.PI)) * 3.5 : 0;
        return [s * 14.5 + sw, 13 + Math.sin(t * 2 + s) * 0.6];
      }
    }
  }
  function stepArm(a, dt) {
    const P = a.pts, sh = l2w(a.side * 11.8, 2.5), base = 2.25 * S;
    P[0].x = sh[0]; P[0].y = sh[1];
    let pin = null;
    if (a.mode === 'reach') {
      const t = a.tgt && a.tgt();
      if (!t) a.mode = 'retract';
      else {
        const dx = t[0] - sh[0], dy = t[1] - sh[1], d = hyp(dx, dy) || 1;
        a.reach = Math.min(d, a.reach + a.spd * dt);
        const k = a.reach / d, nx = -dy / d, ny = dx / d, arc = Math.sin(Math.PI * k) * Math.min(26 * S, d * 0.12) * a.arc;
        pin = [sh[0] + dx * k + nx * arc, sh[1] + dy * k + ny * arc];
        a.rest = Math.max(base, (a.reach / 6) * 1.04);
        if (k >= 0.999) { a.mode = 'grip'; a.grip = a.tgt; a.rope = d; const cb = a.onGrip; a.onGrip = null; if (cb) cb(); }
      }
    }
    if (a.mode === 'grip') {
      const t = a.grip && a.grip();
      if (!t) { a.mode = 'retract'; a.load = false; }
      else { pin = t; const d = hyp(t[0] - sh[0], t[1] - sh[1]); a.rest = Math.max(base, (a.load ? Math.min(d * 1.02, a.rope * 1.06) : d * 1.03) / 6); }
    }
    if (a.mode === 'retract') {
      a.rest += (base - a.rest) * Math.min(1, dt * 13);
      if (Math.abs(a.rest - base) < 0.06 * S) { a.mode = 'pose'; a.rest = base; }
    }
    if (a.mode === 'pose') a.rest = base;
    const pl = poseLocal(a), pw = l2w(pl[0], pl[1]);
    const damp = a.mode === 'retract' ? 0.9 : 0.78, g = 900 * dt * dt;
    for (let i = 1; i < 7; i++) {
      const p = P[i], vx = (p.x - p.px) * damp, vy = (p.y - p.py) * damp;
      p.px = p.x; p.py = p.y; p.x += vx; p.y += vy + g;
    }
    if (pin) { P[6].x = pin[0]; P[6].y = pin[1]; }
    else {
      const k = a.mode === 'pose' ? 0.33 : 0.1;
      P[6].x += (pw[0] - P[6].x) * k; P[6].y += (pw[1] - P[6].y) * k;
      if (a.mode === 'pose') for (let i = 1; i < 6; i++) {
        const t = i / 6; P[i].x += (lerp(sh[0], pw[0], t) - P[i].x) * 0.14; P[i].y += (lerp(sh[1], pw[1], t) - P[i].y) * 0.14;
      }
    }
    for (let it = 0; it < 6; it++) {
      for (let i = 0; i < 6; i++) {
        const p = P[i], q = P[i + 1], dx = q.x - p.x, dy = q.y - p.y, d = hyp(dx, dy) || 1e-6, df = (d - a.rest) / d;
        if (i === 0) { q.x -= dx * df; q.y -= dy * df; }
        else if (i === 5 && pin) { p.x += dx * df; p.y += dy * df; }
        else { p.x += dx * df * 0.5; p.y += dy * df * 0.5; q.x -= dx * df * 0.5; q.y -= dy * df * 0.5; }
      }
      P[0].x = sh[0]; P[0].y = sh[1];
      if (pin) { P[6].x = pin[0]; P[6].y = pin[1]; }
    }
    if (a.carry) a.carry(P[6].x, P[6].y);
  }
  function reach(a, tgt, spd, onGrip) {
    a.mode = 'reach'; a.tgt = tgt; a.reach = hyp(a.pts[6].x - a.pts[0].x, a.pts[6].y - a.pts[0].y);
    a.spd = spd || 1800; a.onGrip = onGrip || null; a.arc = Math.random() < 0.5 ? 1 : -1; a.load = false;
  }
  function letGo(a) { if (a.mode === 'reach' || a.mode === 'grip') a.mode = 'retract'; a.load = false; a.onGrip = null; }
  function resetArms() {
    arms.forEach((a) => { a.carry = null; letGo(a); });
  }

  /* ─ scarf: verlet ribbon ─ */
  const scarf = []; for (let i = 0; i < 8; i++) scarf.push({ x: B.x, y: B.y, px: B.x, py: B.y });
  function stepScarf(dt) {
    const anc = l2w(-frontSide() * 10.5, 8), rest = 3.7 * S;
    const wind = clamp(Math.abs(scrollV) / 2800, 0, 1);
    const fx = (-frontSide() * (620 + Math.sin(T * 1.3) * 260) * (1 - 0.7 * B.lotus) - B.vx * 0.5) * dt * dt;
    const fy = (lerp(260, -170, B.lotus) + Math.sin(T * 2.1) * 180 * (1 - 0.6 * B.lotus) - clamp(scrollV * 0.9, -2600, 2600) * (1 - B.lotus) - B.vy * 0.35) * dt * dt;
    scarf[0].x = anc[0]; scarf[0].y = anc[1];
    for (let i = 1; i < 8; i++) {
      const p = scarf[i], vx = (p.x - p.px) * 0.93, vy = (p.y - p.py) * 0.93;
      const fl = Math.sin(T * (7 + wind * 16) - i * 0.95) * (180 + wind * 900) * (i / 7) * dt * dt;
      p.px = p.x; p.py = p.y; p.x += vx + fx; p.y += vy + fy + fl;
    }
    for (let it = 0; it < 4; it++) {
      for (let i = 0; i < 7; i++) {
        const p = scarf[i], q = scarf[i + 1], dx = q.x - p.x, dy = q.y - p.y, d = hyp(dx, dy) || 1e-6, df = (d - rest) / d;
        if (i === 0) { q.x -= dx * df; q.y -= dy * df; } else { p.x += dx * df * 0.5; p.y += dy * df * 0.5; q.x -= dx * df * 0.5; q.y -= dy * df * 0.5; }
      }
      scarf[0].x = anc[0]; scarf[0].y = anc[1];
    }
  }

  /* ─ legs (procedural) ─ */
  const legs = [[0, 0, 0, 0], [0, 0, 0, 0]];
  function stepLegs() {
    const gy = B.mode === 'ground' ? surfaceY() : 0, sp = Math.min(1, Math.abs(B.vx) / 70);
    for (let k = 0; k < 2; k++) {
      const side = k ? 1 : -1, hip = l2w(side * 5.4, 15);
      let fx, fy;
      if (B.mode === 'ground' && B.sitK < 0.5) {
        const ph = B.walkPh + (k ? Math.PI : 0);
        fx = B.x + (side * 5.6 + Math.sin(ph) * 5.5 * sp * B.face) * S;
        fy = gy - Math.max(0, Math.cos(ph)) * 3.6 * S * sp;
      } else if (B.mode === 'ground' && B.lotus > 0.4) {      // lotus: feet tucked across
        fx = hip[0] - side * 6.8 * S; fy = hip[1] + 5.4 * S;
      } else if (B.mode === 'ground' && !B.surf) {            // sitting on the floor: feet out front
        fx = hip[0] + (B.face * 5 + side * 2.6) * S; fy = gy - 0.5;
      } else if (B.mode === 'ground') {                       // sitting: dangle over the edge
        fx = hip[0] + (B.face * 3.5 + side * 2) * S;
        fy = hip[1] + (8.5 + Math.sin(T * 3.1 + k * 1.7) * 1.2) * S;
      } else {
        const kick = B.mode === 'held' ? Math.sin(T * 21 + k * 2) * 2.5 : Math.sin(T * 7 + k * 2) * 1.2;
        fx = hip[0] + (side * 1.4 - clamp(B.vx * 0.004, -5, 5)) * S;
        fy = hip[1] + (9.3 - clamp(B.vy * 0.003, -4, 3) + kick) * S;
      }
      legs[k][0] = hip[0]; legs[k][1] = hip[1]; legs[k][2] = fx; legs[k][3] = fy;
    }
  }

  /* ───────────────────────── fx layer (DOM) ───────────────────────── */
  const fx = document.createElement('div'); fx.id = 'kz-fx'; document.body.appendChild(fx);
  function say(txt, cls) {
    const s = document.createElement('span'); s.className = 'kz-g' + (cls ? ' ' + cls : ''); s.textContent = txt;
    const hp2 = l2w(0, -26);
    s.style.left = clamp(hp2[0], 30, W - 30) + 'px'; s.style.top = clamp(hp2[1] - 6, 8, H - 20) + 'px';
    s.style.setProperty('--dx', rnd(-16, 16).toFixed(0) + 'px'); s.style.setProperty('--rot', rnd(-10, 10).toFixed(0) + 'deg');
    fx.appendChild(s); s.addEventListener('animationend', () => s.remove());
  }
  function dust(x, y, n, dir) {
    for (let i = 0; i < (n || 3); i++) {
      const d = document.createElement('span'); d.className = 'kz-dust';
      d.style.left = (x + rnd(-6, 6)) + 'px'; d.style.top = (y - rnd(0, 3)) + 'px';
      d.style.setProperty('--dx', ((dir || (Math.random() < 0.5 ? -1 : 1)) * rnd(6, 20)).toFixed(0) + 'px');
      fx.appendChild(d); d.addEventListener('animationend', () => d.remove());
    }
  }
  function steam(n) {
    for (let i = 0; i < (n || 1); i++) {
      const e = document.createElement('span'); e.className = 'kz-steam'; const p2 = l2w(rnd(-13, 13), rnd(-16, 8));
      e.style.left = p2[0] + 'px'; e.style.top = p2[1] + 'px'; e.style.setProperty('--dx', rnd(-16, 16).toFixed(0) + 'px');
      fx.appendChild(e); e.addEventListener('animationend', () => e.remove());
    }
  }
  function speedLine() {
    const e = document.createElement('span'); e.className = 'kz-speed'; const p2 = l2w(0, rnd(-12, 16));
    e.style.left = (p2[0] - B.face * 22 * S - 11) + 'px'; e.style.top = p2[1] + 'px'; e.style.setProperty('--dx', (-B.face * 46) + 'px');
    fx.appendChild(e); e.addEventListener('animationend', () => e.remove());
  }
  function confetti(x, y, n) {
    const cols = ['#e8453c', '#f4b400', '#3aa6ff', '#2bb673', `rgb(${INK.map((v) => (v * 255) | 0)})`];
    for (let i = 0; i < n; i++) {
      const c = document.createElement('span'); c.className = 'kz-conf'; c.style.background = pick(cols);
      c.style.left = x + 'px'; c.style.top = y + 'px';
      c.style.setProperty('--dx', rnd(-160, 160).toFixed(0) + 'px'); c.style.setProperty('--up', rnd(-170, -70).toFixed(0) + 'px');
      c.style.setProperty('--dy', rnd(40, 200).toFixed(0) + 'px'); c.style.setProperty('--r', rnd(-720, 720).toFixed(0) + 'deg');
      c.style.animationDelay = rnd(0, 0.12).toFixed(2) + 's';
      fx.appendChild(c); c.addEventListener('animationend', () => c.remove());
    }
  }
  let bannerEl = null;
  function banner(html, ms) {
    if (bannerEl) bannerEl.remove();
    bannerEl = document.createElement('div'); bannerEl.className = 'kz-banner'; bannerEl.innerHTML = html; fx.appendChild(bannerEl);
    const el = bannerEl; setTimeout(() => { if (bannerEl === el) { el.remove(); bannerEl = null; } }, ms || 6500);
  }
  function placeBanner() {
    if (!bannerEl) return;
    const hp2 = l2w(0, -30), bw = bannerEl.offsetWidth || 180;
    bannerEl.style.left = clamp(hp2[0], bw / 2 + 8, W - bw / 2 - 8) + 'px';
    bannerEl.style.top = clamp(hp2[1] - 6, bannerEl.offsetHeight + 8, H) + 'px';
  }
  /* rubber world: the page ripples out from a hard impact */
  function quake(x, y, power) {
    const els = document.querySelectorAll('main p, main li, main h2, main h3, main pre, main .image-frame, main blockquote, main table');
    let n = 0;
    for (const el of els) {
      if (n > 26) break;
      const r = el.getBoundingClientRect(); if (r.bottom < 0 || r.top > H) continue;
      const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom), d = hyp(dx, dy);
      if (d > 320) continue;
      n++;
      el.style.setProperty('--q', (power * (1 - d / 320) * 9).toFixed(1) + 'px');
      el.style.animationDelay = (d / 900).toFixed(3) + 's';
      el.classList.remove('kz-quake'); void el.offsetWidth; el.classList.add('kz-quake');
      el.addEventListener('animationend', function f() { el.classList.remove('kz-quake'); el.style.animationDelay = ''; el.removeEventListener('animationend', f); });
    }
  }

  /* ───────────────────────── physics steps ───────────────────────── */
  function kick(v) { B.sqv += v; }
  function hatKick(v) { B.hatRv += v; }
  function land(impact, onPerch) {
    B.mode = 'ground'; B.vy = 0; B.vx *= 0.35; B.rv = 0; B.bounces = 0;
    const k = clamp(impact / 900, 0.15, 1.3);
    kick(-4.5 * k - 1); hatKick(sgn(B.rot || 1) * 4 * k);
    const fy = B.y + FOOT * S; dust(B.x, fy, impact > 700 ? 6 : 3);
    if (impact > 1500 && !MOBILE()) quake(B.x, fy, clamp(impact / 2500, 0.4, 1.2));
    if (!onPerch) B.surf = null;
  }
  function groundStep(dt) {
    if (B.surf) {
      const r = B.surf.el.getBoundingClientRect();
      const lost = !B.surf.el.isConnected || r.width === 0 || r.top < 60 || r.top > floorY() - 30;
      if (lost) { B.surf = null; B.mode = 'air'; B.vy = -120; B.sit = 0; if (Math.random() < 0.5) say('whoa'); return; }
      const px = B.surf.side < 0 ? r.left + 5 * S : r.right - 5 * S;
      B.x = px + B.surfDX;
    }
    B.vx += (B.want - B.vx) * Math.min(1, dt * 7);
    if (!B.surf) B.x += B.vx * dt;
    if (Math.abs(B.vx) > 6) B.face = sgn(B.vx);
    B.walkPh += Math.abs(B.vx) * dt * 0.19;
    B.sitK += (B.sit - B.sitK) * Math.min(1, dt * 9);
    const sp = Math.min(1, Math.abs(B.vx) / 70);
    const bob = -Math.abs(Math.sin(B.walkPh)) * 1.3 * S * sp;
    B.y = surfaceY() - lerp(FOOT, SEAT - 0.5, B.sitK) * S + bob - B.lev * S;
    const lim = 16 * S, rlim = B.surf ? lim : (MOBILE() ? lim : 76); if (B.x < lim) { B.x = lim; B.want = 0; } if (B.x > W - rlim) { B.x = W - rlim; B.want = 0; }
    const tr = clamp(B.vx * 0.0014, -0.16, 0.16);
    B.rv += ((tr - B.rot) * 170 - B.rv * 15) * dt; B.rot += B.rv * dt;
  }
  function airStep(dt) {
    const pfy = B.y + FOOT * S;
    B.vy += G * dt; B.vx *= 1 - 0.15 * dt;
    B.x += B.vx * dt; B.y += B.vy * dt; B.rot += B.rv * dt; B.rv *= 1 - 0.6 * dt;
    if (Math.abs(B.rv) < 0.5) { B.rv += (-Math.atan2(Math.sin(B.rot), Math.cos(B.rot)) * 30 - B.rv * 5) * dt; }
    const fy = B.y + FOOT * S, lim = 16 * S;
    if (B.x < lim) { B.x = lim; B.vx = Math.abs(B.vx) * 0.5; kick(-2.5); hatKick(4); if (Math.abs(B.vx) > 300) dust(B.x - 10, B.y, 3, 1); }
    if (B.x > W - lim) { B.x = W - lim; B.vx = -Math.abs(B.vx) * 0.5; kick(-2.5); hatKick(-4); if (Math.abs(B.vx) > 300) dust(B.x + 10, B.y, 3, -1); }
    if (B.y < 34 * S) { B.y = 34 * S; B.vy = Math.abs(B.vy) * 0.4; kick(-2); }
    if (B.vy > 0 && !MOBILE()) {                           // land on a perch corner?
      for (const p of perchList(true)) {
        const r = p.el.getBoundingClientRect(), px = p.side < 0 ? r.left + 5 * S : r.right - 5 * S;
        if (pfy <= r.top + 2 && fy >= r.top && Math.abs(B.x - px) < 30 * S && r.top > 70 && r.top < floorY() - 40) {
          B.surf = p; B.surfDX = clamp(B.x - px, -12 * S, 12 * S); const imp = B.vy;
          B.rot = Math.atan2(Math.sin(B.rot), Math.cos(B.rot)); land(imp, true); return;
        }
      }
    }
    const fl = floorY();
    if (fy >= fl) {
      B.y = fl - FOOT * S; B.rot = Math.atan2(Math.sin(B.rot), Math.cos(B.rot));
      if (B.vy > 650 && B.bounces < 2) { B.bounces++; const imp = B.vy; B.vy = -B.vy * 0.36; B.vx *= 0.8; kick(-imp * 0.004); dust(B.x, fl, 4); if (imp > 1500 && !MOBILE()) quake(B.x, fl, clamp(imp / 2500, 0.4, 1.2)); }
      else land(B.vy, false);
    }
  }
  function hangStep(dt) {
    const a = arms.find((x) => x.mode === 'grip' && x.load);
    if (!a) { B.mode = 'air'; return; }
    const hand = a.pts[6], dx = hand.x - B.x, dy = hand.y - B.y, d = hyp(dx, dy) || 1, ux = dx / d, uy = dy / d;
    let ax = 0, ay = G;
    if (d > a.rope) { const k = a.stiff || 150; ax += ux * k * (d - a.rope); ay += uy * k * (d - a.rope); const vr = B.vx * ux + B.vy * uy; ax -= ux * vr * 6; ay -= uy * vr * 6; }
    B.vx += ax * dt; B.vy += ay * dt; B.vx *= 1 - 0.25 * dt; B.vy *= 1 - 0.25 * dt;
    B.x += B.vx * dt; B.y += B.vy * dt;
    const tr = Math.atan2(ux, -uy);
    B.rv += ((tr - B.rot) * 220 - B.rv * 16) * dt; B.rot += B.rv * dt;
    const fl = floorY(); if (B.y + FOOT * S > fl) { B.y = fl - FOOT * S; if (B.vy > 0) B.vy = 0; }
    if (B.x < 16 * S) { B.x = 16 * S; B.vx = Math.abs(B.vx) * 0.4; } if (B.x > W - 16 * S) { B.x = W - 16 * S; B.vx = -Math.abs(B.vx) * 0.4; }
  }
  let drag = null;
  function heldStep(dt) {
    const tx = drag.x + drag.ox, ty = drag.y + drag.oy;
    const ax = (tx - B.x) * 260 - B.vx * 22, ay = (ty - B.y) * 260 - B.vy * 22;
    B.vx += ax * dt; B.vy += ay * dt; B.x += B.vx * dt; B.y += B.vy * dt;
    const tr = clamp(B.vx * 0.0011, -0.6, 0.6);
    B.rv += ((tr - B.rot) * 160 - B.rv * 12) * dt; B.rot += B.rv * dt;
    B.sq += (clamp(Math.abs(B.vy) / 3000 - Math.abs(B.vx) / 6000, -0.2, 0.25) - B.sq) * Math.min(1, dt * 10);
  }

  /* ───────────────────────── perches ───────────────────────── */
  let perches = [], perchAt = 0;
  const perchKeys = new WeakMap();
  function perchList(force) {
    const t = now(); if (!force && t - perchAt < 500 && perches.length) return perches;
    if (force && t - perchAt < 250) return perches;
    perchAt = t; perches = [];
    const sel = '.article-content h2, .article-content h3, .article-content .image-frame, .article-content .highlight-wrapper, .article-content table, main .image-frame';
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 90 || r.bottom < 0 || r.top > H) continue;
      let pp = perchKeys.get(el); if (!pp) { pp = [{ el, side: -1 }, { el, side: 1 }]; perchKeys.set(el, pp); }
      perches.push(pp[0], pp[1]);
    }
    return perches;
  }
  function perchPoint(p) { const r = p.el.getBoundingClientRect(); return [p.side < 0 ? r.left + 5 * S : r.right - 5 * S, r.top]; }
  function goodPerches() {
    return perchList().filter((p) => { const [x, y] = perchPoint(p); return y > 110 && y < floorY() - 110 && x > 20 && x < W - 20 && p !== B.surf; });
  }
  function gutters() {
    const m = (document.querySelector('main') || document.body).getBoundingClientRect(), g = [];
    if (m.left > 70) g.push([22 * S, m.left - 26]); if (W - m.right > 120) g.push([m.right + 26, W - 80]);
    return g;
  }
  function gutterX() {
    const g = gutters();
    if (g.length) { const z = pick(g); return rnd(z[0], z[1]); }
    return Math.random() < 0.5 ? rnd(24, 90) : rnd(W - 130, W - 80);
  }

  /* ───────────────────────── words (rubber pluck + gear-5) ───────────────────────── */
  let pool = null;
  function thought() {
    if (!pool) {
      pool = []; const seen = {};
      const els = (document.querySelector('.article-content') || document.querySelector('main') || document.body).querySelectorAll('h2,h3,p,li,strong,em');
      for (const e of els) {
        if (e.closest('pre,code,.table-of-content')) continue;
        for (const w of (e.textContent || '').match(/[A-Za-z][A-Za-z'’-]{3,12}/g) || []) { const k = w.toLowerCase(); if (!seen[k]) { seen[k] = 1; pool.push(w); } }
      }
    }
    return pool.length ? pick(pool) : pick(['?', '…', '!']);
  }
  function visibleBlocks() {
    const root2 = document.querySelector('.article-content') || document.querySelector('main');
    if (!root2) return [];
    return [...root2.querySelectorAll('p,li,h2,h3,blockquote,td')].filter((e) => {
      if (e.closest('pre,code,nav,.table-of-content,.katex')) return false;
      const r = e.getBoundingClientRect(); return r.bottom > 90 && r.top < H - 110 && r.width > 0;
    });
  }
  function pickWord(maxD) {
    const nodes = [];
    for (const blk of visibleBlocks()) {
      const wk = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT, { acceptNode(n) {
        if (!/[A-Za-z]{3}/.test(n.nodeValue || '')) return 2;
        const p = n.parentNode; if (!p || !p.closest || p.closest('a,code,pre,.katex,svg,#kaze,#kz-fx,.kz-w')) return 2; return 1;
      } });
      let n; while ((n = wk.nextNode())) nodes.push(n);
    }
    const t = now();
    for (let i = 0; i < 50 && nodes.length; i++) {
      const nd = pick(nodes), txt = nd.nodeValue, ms = []; let m; const re = /[A-Za-z][A-Za-z'’-]{2,12}/g;
      while ((m = re.exec(txt))) ms.push(m);
      if (!ms.length) continue;
      const mm = pick(ms), rg = document.createRange(); rg.setStart(nd, mm.index); rg.setEnd(nd, mm.index + mm[0].length);
      const r = rg.getBoundingClientRect();
      if (r.width < 10 || r.top < 90 || r.bottom > H - 110 || r.left < 4 || r.right > W - 4) continue;
      if (hyp(r.left + r.width / 2 - B.x, r.top - B.y) > maxD) continue;
      if (t - lastMouseAt < 5000 && Math.abs(r.top + r.height / 2 - mouseY) < 110) continue;   // don't steal what you're reading
      return { node: nd, s: mm.index, e: mm.index + mm[0].length };
    }
    return null;
  }
  let word = null;   // { span, clone, ... }
  function liftWord(pk) {
    let span;
    try { const rg = document.createRange(); rg.setStart(pk.node, pk.s); rg.setEnd(pk.node, pk.e); span = document.createElement('span'); rg.surroundContents(span); }
    catch (e) { return null; }
    const cs = getComputedStyle(span.parentNode), r = span.getBoundingClientRect();
    const clone = document.createElement('div'); clone.className = 'kz-word'; clone.textContent = span.textContent;
    clone.style.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`;
    clone.style.letterSpacing = cs.letterSpacing; clone.style.color = cs.color; clone.style.opacity = '0';
    fx.appendChild(clone);
    return { span, clone, w: r.width, h: r.height, x: r.left, y: r.top, rot: 0, sc: 1, op: 1, lifted: false };
  }
  function wordSocket() { if (!word) return null; const r = word.span.getBoundingClientRect(); if (!word.span.isConnected) return null; return [r.left + r.width / 2, r.top + r.height / 2]; }
  function paintWord() {
    if (!word) return;
    word.clone.style.opacity = word.lifted ? word.op : 0;
    word.clone.style.transform = `translate(${(word.x).toFixed(1)}px,${(word.y).toFixed(1)}px) rotate(${word.rot.toFixed(1)}deg) scale(${word.sc.toFixed(3)})`;
  }
  function dropWord() {
    if (!word) return;
    try { word.clone.remove(); } catch (e) { /* noop */ }
    try { const sp = word.span, p = sp.parentNode; if (p) { p.replaceChild(document.createTextNode(sp.textContent), sp); p.normalize(); } } catch (e) { /* noop */ }
    word = null;
  }
  let line = null;   // gear-5 line
  function restoreLine() {
    if (!line) return;
    if (line.stars) line.stars.remove();
    if (line.el.__kz != null) { line.el.textContent = line.el.__kz; delete line.el.__kz; }
    line = null;
  }

  /* ───────────────────────── acts (behaviour) ───────────────────────── */
  let act = null;
  function run(a) {
    if (act && act.end) act.end();
    act = a; if (!a) return;
    a.t0 = now(); if (a.start) a.start();
  }
  const neutral = () => { B.pose = 'rest'; B.eye = 0; B.mouth = 0; B.blush = 0; B.sit = 0; B.want = 0; };

  const wait = (dur) => ({ name: 'wait', update(t) { return B.mode === 'ground' && t - this.t0 > (dur || 0); } });
  let pendingHello = null;
  const idle = (dur) => ({
    name: 'idle',
    start() { neutral(); },
    update(t) {
      if (!this.lk || t > this.lk) { this.lk = t + rnd(700, 2000); if (t > lookLock) lookAt = Math.random() < 0.5 ? null : [rnd(0, W), rnd(0, H)]; }
      return t - this.t0 > dur;
    },
  });
  const walkTo = (x) => ({
    name: 'walk',
    start() { neutral(); this.spd = rnd(60, 85) * S; },
    update(t) {
      if (B.mode !== 'ground' || B.surf) return true;
      const dx = x - B.x; if (Math.abs(dx) < 5 || t - this.t0 > 9000) { B.want = 0; return true; }
      B.want = sgn(dx) * this.spd;
    },
    end() { B.want = 0; },
  });
  function launchTo(tx, ty) {
    const fy = B.y + FOOT * S, apex = Math.min(fy, ty) - rnd(38, 64) * S, up = fy - apex, down = Math.max(1, ty - apex);
    const tt = Math.sqrt(2 * up / G) + Math.sqrt(2 * down / G);
    B.vy = -Math.sqrt(2 * G * up); B.vx = (tx - B.x) / tt; B.mode = 'air'; B.surf = null; B.sit = 0; B.sitK = 0;
    B.rv = Math.abs(tx - B.x) > 160 && Math.random() < 0.35 ? sgn(tx - B.x) * (2 * Math.PI) / tt : 0;   // sometimes a flip
    kick(7); hatKick(-sgn(B.vx) * 3); dust(B.x, fy, 3);
  }
  const hopTo = (dest) => ({     // dest: {x,y} | perch
    name: 'hop',
    start() { neutral(); if (B.mode !== 'ground') { this.fail = true; return; } const d = dest.el ? perchPoint(dest) : [dest.x, dest.y]; B.face = sgn(d[0] - B.x); kick(-5.5); },
    update(t) {
      if (this.fail) return true;
      const e = t - this.t0;
      if (!this.go && e > 130) { this.go = true; const d = dest.el ? perchPoint(dest) : [dest.x, dest.y]; launchTo(d[0], d[1]); }
      return (this.go && B.mode === 'ground' && e > 260) || e > 4500;
    },
  });
  const sit = (dur) => ({
    name: 'sit', start() { neutral(); B.sit = 1; }, update(t) { if (B.mode !== 'ground') return true; return t - this.t0 > dur; }, end() { B.sit = 0; },
  });
  const sleep = (dur) => ({
    name: 'sleep',
    start() { neutral(); B.sit = 1; B.pose = 'sleep'; this.z = 0; },
    update(t) {
      const e = t - this.t0;
      if (!this.wake) { B.eye = 2; B.hatSlide = Math.min(1, B.hatSlide + 0.02); if (t > this.z) { this.z = t + 1300; say('z', 'kz-z'); } if (e > dur) this.wake = t; }
      else { B.hatSlide = Math.max(0, B.hatSlide - 0.06); B.eye = 0; B.mouth = 3; B.mouthO = 1; B.pose = 'up'; if (t - this.wake > 900) return true; }
      if (B.mode !== 'ground') return true;
    },
    end() { B.hatSlide = 0; B.mouth = 0; B.sit = 0; },
  });
  const laugh = (dur, txt) => ({
    name: 'laugh',
    start() { neutral(); B.eye = 1; B.mouth = 2; B.blush = 0.7; say(txt || pick(['ha ha!', 'hahaha!', 'heh heh'])); this.k = 0; },
    update(t) {
      if (t > this.k) { this.k = t + 90; kick(Math.random() < 0.5 ? 2.2 : -2.2); }
      B.mouthO = 0.6 + Math.sin(t / 45) * 0.4;
      return t - this.t0 > dur;
    },
    end() { B.mouth = 0; B.eye = 0; B.blush = 0; },
  });
  const wave = (txt, dur) => ({
    name: 'wave',
    start() { neutral(); B.pose = 'wave'; B.eye = 1; B.mouth = 1; if (txt) say(txt, 'kz-big'); if (B.mode === 'ground') B.face = sgn((mouseX > 0 ? mouseX : W / 2) - B.x); },
    update(t) { return t - this.t0 > (dur || 1800); },
    end() { B.pose = 'rest'; B.eye = 0; B.mouth = 0; },
  });
  const shrug = (txt) => ({
    name: 'shrug', start() { neutral(); B.pose = 'shrug'; B.mouth = 1; say(txt, 'kz-big'); lookAt = [B.x, 0]; lookLock = now() + 1500; },
    update(t) { return t - this.t0 > 2200; }, end() { B.pose = 'rest'; B.mouth = 0; },
  });
  const cheer = (txt) => ({
    name: 'cheer',
    start() { neutral(); B.pose = 'wide'; B.eye = 1; B.mouth = 2; B.mouthO = 0.8; if (txt) say(txt, 'kz-big'); if (B.mode === 'ground') { kick(-4); this.j = now() + 110; } },
    update(t) { if (this.j && t > this.j && B.mode === 'ground') { this.j = 0; B.vy = -560; B.mode = 'air'; B.surf = null; kick(7); } return t - this.t0 > 1500 && B.mode === 'ground'; },
    end() { B.pose = 'rest'; B.eye = 0; B.mouth = 0; },
  });
  const love = () => ({
    name: 'love',
    start() { neutral(); B.pose = 'wide'; B.eye = 1; B.blush = 1; B.mouth = 1; say('love you!', 'kz-big'); this.h = 0; },
    update(t) { if (t > this.h) { this.h = t + 260; say('♥', 'kz-heart'); } return t - this.t0 > 2600; },
    end() { B.pose = 'rest'; B.eye = 0; B.blush = 0; B.mouth = 0; },
  });
  const finale = (tldr) => ({
    name: 'finale',
    start() {
      neutral();
      if (tldr) { this.sub = shrug('tl;dr? 👀'); this.sub.t0 = now(); this.sub.start(); return; }
      B.pose = 'wide'; B.eye = 1; B.mouth = 2; B.mouthO = 0.9; B.blush = 0.6;
      if (!B.hatFree) B.hatToss = { t0: now() };
      const hp2 = l2w(0, -20); confetti(hp2[0], hp2[1], 34);
      this.bn = now() + 1050;
    },
    update(t) { if (this.sub) return this.sub.update(t); if (this.bn && t > this.bn) { this.bn = 0; banner('Thanks for reading! <b>❤</b><br>set your ideas free — share it', 7000); } placeBanner(); return t - this.t0 > 3600; },
    end() { if (this.sub) this.sub.end(); B.pose = 'rest'; B.eye = 0; B.mouth = 0; B.blush = 0; },
  });

  /* meditation: lotus, levitate, ॐ — the wind can't touch him */
  function aura(n, gap) {                          // dotted rings that drift outward, turn slowly and fade
    const c = l2w(0, 2);
    for (let i = 0; i < n; i++) {
      const a = document.createElement('span'); a.className = 'kz-aura';
      a.style.left = c[0] + 'px'; a.style.top = c[1] + 'px'; a.style.width = a.style.height = (92 * S) + 'px';
      a.style.animationDelay = (i * (gap || 0.6)).toFixed(2) + 's';
      a.style.setProperty('--spin', (Math.random() < 0.5 ? -1 : 1) * rnd(25, 60) + 'deg');
      fx.appendChild(a); a.addEventListener('animationend', () => a.remove());
    }
  }
  function om() { say('ॐ', 'kz-om'); auraP = 1; aura(1); }
  const meditate = (dur) => ({
    name: 'meditate',
    start() { neutral(); B.sit = 1; B.pose = 'lotus'; this.om = now() + 1700; this.mo = 0; dur = Math.max(dur, 10000); auraT = 1; },
    update(t) {
      if (B.mode !== 'ground') return true;
      const e = t - this.t0;
      if (!this.out) {
        B.lotus = Math.min(1, B.lotus + 0.04);
        const lift = e < 1100 ? 0 : Math.min(1, (e - 1100) / 2400), hi = MOBILE() ? 17 : 11;
        B.lev = lift * (hi + Math.sin(t / 850) * 2.2);
        B.eye = e > 450 ? 4 : 0; B.blush = 0.3; lookAt = null; lookLock = t + 400;
        if (t > this.om) { this.om = t + rnd(2700, 3500); this.mo = t; om(); }
        const m = this.mo ? (t - this.mo) / 1500 : 1;
        if (m < 1) { B.mouth = 3; B.mouthO = Math.sin(m * Math.PI) * 0.75; } else B.mouth = 1;
        if (e > dur || (this.wake && e > 10000)) { this.out = t; auraT = 0; this.l0 = B.lev; say(pick(['ahh…', 'peace ☮', 'zen.'])); }
      } else {
        const k = Math.min(1, (t - this.out) / 750);
        B.lev = this.l0 * (1 - k * k); B.lotus = 1 - k; B.eye = k > 0.55 ? 1 : 4; B.mouth = 1;
        if (k >= 1) { kick(-2.5); return true; }
      }
    },
    end() { auraT = 0; B.lev = 0; B.lotus = 0; B.sit = 0; B.pose = 'rest'; B.eye = 0; B.mouth = 0; B.blush = 0; lookLock = 0; },
  });

  /* rubber pluck: stretch an arm to a word, yank it, read or eat it, put it back */
  const pluck = () => ({
    name: 'pluck',
    start() {
      neutral();
      const pk = pickWord(MOBILE() ? 0 : 520); if (!pk) { this.done = true; return; }
      word = liftWord(pk); if (!word) { this.done = true; return; }
      const s = wordSocket(); B.face = sgn(s[0] - B.x); this.arm = armFor(frontSide());
      this.mode = Math.random() < 0.55 ? 'read' : 'eat'; this.ph = 'reach';
      lookAt = s; lookLock = now() + 99999;
      reach(this.arm, wordSocket, 1700, () => { this.ph = 'yank'; this.k = now(); word.lifted = true; word.span.style.visibility = 'hidden'; kick(-3); });
    },
    update(t) {
      if (this.done) return true;
      if (!word || t - this.t0 > 14000) return true;
      const a = this.arm, h = a.pts[6];
      if (this.ph === 'reach') { const s = wordSocket(); if (!s || s[1] < 40 || s[1] > H - 40) { letGo(a); return true; } lookAt = s; }
      else if (this.ph === 'yank') {
        const s = wordSocket(); word.x = s[0] - word.w / 2; word.y = s[1] - word.h / 2;
        if (t - this.k > 140) { this.ph = 'pull'; a.carry = (x, y) => { word.x = x - word.w / 2 - B.faceS * 4 * S; word.y = y - word.h - 3 * S; word.rot += 6; }; letGo(a); B.pose = 'hold'; }
      } else if (this.ph === 'pull') {
        word.rot *= 0.9; lookAt = [word.x + word.w / 2, word.y + word.h / 2];
        if (a.mode === 'pose') { this.ph = this.mode; this.k = t; this.b = 0; if (this.mode === 'eat') { a.carry = null; this.ex = word.x; this.ey = word.y; } }
      } else if (this.ph === 'read') {
        word.rot = Math.sin(t / 380) * 5; B.eye = 0; lookAt = [word.x + word.w / 2, word.y + word.h / 2];
        if (t > this.b) { this.b = t + rnd(500, 900); say(thought()); }
        if (t - this.k > 2300) this.ret(t);
      } else if (this.ph === 'eat') {
        const e = t - this.k, mw = l2w(B.faceS * 2.4, 2);
        if (e < 520) { const k = e / 520; word.x = lerp(this.ex, mw[0] - word.w / 2, k); word.y = lerp(this.ey, mw[1] - word.h / 2, k); word.sc = 1 - 0.9 * k; word.rot += 9; B.mouth = 2; B.mouthO = 1 - k * 0.4; }
        else if (e < 1250) { word.op = 0; B.mouth = 2; B.mouthO = 0.35 + Math.abs(Math.sin(e / 70)) * 0.5; if (!this.nom) { this.nom = 1; say('nom'); } if (Math.random() < 0.15) kick(1.5); }
        else if (e < 1450) { B.mouth = 3; B.mouthO = 1; B.eye = 3; }
        else { this.ph = 'spit'; this.k = t; this.sx = mw[0]; this.sy = mw[1]; say('ptoo!'); kick(-4); word.op = 1; B.eye = 0; B.mouth = 3; }
      } else if (this.ph === 'spit') {
        const s = wordSocket(); if (!s) return true;
        const k = Math.min(1, (t - this.k) / 480), arc = Math.sin(k * Math.PI) * 70;
        word.x = lerp(this.sx, s[0], k) - word.w / 2; word.y = lerp(this.sy, s[1], k) - word.h / 2 - arc;
        word.sc = lerp(0.2, 1, Math.min(1, k * 1.6)); word.rot = (1 - k) * 540;
        if (k >= 1) { dropWord(); B.mouth = 0; return true; }
      } else if (this.ph === 'return') {
        if (a.mode === 'grip' || a.mode === 'retract' || a.mode === 'pose') { if (!this.put) { this.put = true; a.carry = null; dropWord(); letGo(a); } }
        if (a.mode === 'pose') return true;
      }
    },
    ret() { this.ph = 'return'; const a = this.arm; B.pose = 'rest'; reach(a, wordSocket, 1500, () => { a.carry = null; dropWord(); letGo(a); }); },
    end() { if (this.arm) { this.arm.carry = null; letGo(this.arm); } dropWord(); lookLock = 0; B.pose = 'rest'; B.mouth = 0; },
  });

  /* rubber rocket: grab a far corner and fling yourself there */
  const rocket = (dest) => ({
    name: 'rocket',
    start() {
      neutral();
      const cands = goodPerches().filter((p) => { const q = perchPoint(p); return hyp(q[0] - B.x, q[1] - B.y) > 180; });
      this.p = dest || pick(cands); if (!this.p || B.mode !== 'ground') { this.done = true; return; }
      const q0 = perchPoint(this.p); B.face = sgn(q0[0] - B.x); this.arm = armFor(frontSide());
      this.anchor = () => { const q = perchPoint(this.p); return [q[0], q[1] - 3 * S]; };
      lookAt = q0; lookLock = now() + 4000;
      reach(this.arm, this.anchor, 2600, () => { this.ph = 'load'; this.k = now(); });
      this.ph = 'reach';
    },
    update(t) {
      if (this.done) return true;
      const a = this.arm;
      if (t - this.t0 > 5000) return true;
      if (this.ph === 'reach') { B.sq += (-0.12 - B.sq) * 0.1; return false; }
      if (this.ph === 'load') { B.sq += (-0.32 - B.sq) * 0.25; B.eye = 3; if (t - this.k > 230) { this.ph = 'fly'; this.k = t; this.v = 300; this.lt = t; B.eye = 0; B.mouth = 2; B.mouthO = 0.7; B.mode = 'zip'; B.surf = null; kick(8); } return false; }
      if (this.ph === 'fly') {                         // the rubber contracts: zip toward the hand
        const dt = Math.min(0.034, (t - this.lt) / 1000); this.lt = t;
        const q = this.anchor(), dx = q[0] - B.x, dy = q[1] - 12 * S - B.y, d = hyp(dx, dy) || 1;
        this.v = Math.min(2900, this.v + 9000 * dt); const st = Math.min(d, this.v * dt);
        B.vx = (dx / d) * this.v; B.vy = (dy / d) * this.v; B.x += (dx / d) * st; B.y += (dy / d) * st;
        const tr = Math.atan2(dx / d, -dy / d); B.rot += (tr - B.rot) * 0.35; B.sq += (0.28 - B.sq) * 0.3;
        if (Math.random() < 0.5) dust(B.x - (dx / d) * 20, B.y - (dy / d) * 20, 1);
        if (d < 26 * S || t - this.k > 1400) {
          letGo(a); B.mode = 'air'; B.x = q[0]; B.vx = sgn(dx) * 60; B.vy = -420; B.rv = -B.rot * 4; kick(-5); this.ph = 'land'; say(pick(['yosh!', 'made it!', '♪']));
        }
        return false;
      }
      if (this.ph === 'land') return B.mode === 'ground';
    },
    end() { if (this.arm) { this.arm.stiff = 0; letGo(this.arm); } if (B.mode === 'hang' || B.mode === 'zip') B.mode = 'air'; B.mouth = 0; lookLock = 0; },
  });

  /* hang off the reading-progress bar and swing while you read */
  const bar = () => document.getElementById('reading-progress');
  function barTip() { const b = bar(); if (!b) return null; const r = b.getBoundingClientRect(); return [r.right - 1, r.top + 1.5]; }
  function barOK() { const tp = barTip(); return !!tp && tp[0] > 110 && tp[0] < W - 110 && !MOBILE(); }
  const swing = () => ({
    name: 'swing',
    start() {
      neutral(); if (!barOK()) { this.done = true; return; }
      const tp = barTip(); B.face = sgn(tp[0] - B.x); this.arm = armFor(frontSide());
      lookAt = tp; lookLock = now() + 1500; this.dur = rnd(9000, 16000);
      reach(this.arm, barTip, 2400, () => {
        const a = this.arm; B.mode = 'hang'; B.surf = null; a.load = true; a.stiff = 150;
        a.rope = hyp(a.pts[6].x - B.x, a.pts[6].y - B.y); this.target = (readingMode() ? 85 : clamp(H * 0.26, 110, 210)) * S; kick(5); say(pick(['wheee', 'yohoo!', '♪']));
      });
    },
    update(t) {
      if (this.done) return true;
      const a = this.arm, e = t - this.t0;
      if (B.mode === 'hang') {
        a.rope += (this.target - a.rope) * 0.03; B.pose = 'swing'; B.eye = 1; B.mouth = 1;
        const tp = barTip(), prog = articleProgress();
        if (!tp || e > this.dur || tp[0] < 60 || tp[0] > W - 60 || prog > 0.96 || scrollV < -900) {
          letGo(a); B.mode = 'air'; B.vy -= 380; B.rv = sgn(B.vx || 1) * 7; B.pose = 'up'; say(pick(['freedom!', 'yahoo!', 'whee!'])); this.ph = 'drop';
        }
      } else if (this.ph === 'drop') { if (B.mode === 'ground') return true; }
      else if (a.mode !== 'reach' && a.mode !== 'grip') return true;
      return e > 30000;
    },
    end() { if (this.arm) { this.arm.stiff = 0; letGo(this.arm); } if (B.mode === 'hang') B.mode = 'air'; B.pose = 'rest'; B.eye = 0; B.mouth = 0; },
  });

  /* gear-5: stand on a line of text, run it into a pile, get launched by the snap-back */
  function pickLine() {
    const root2 = document.querySelector('.article-content') || document.querySelector('main'); if (!root2) return null;
    const c = [];
    for (const e of root2.querySelectorAll('h2,h3,h4,li,p,blockquote')) {
      if (e.children.length || e.closest('.table-of-content,pre,code')) continue;
      const r = e.getBoundingClientRect(), fs = parseFloat(getComputedStyle(e).fontSize) || 16, n = (e.textContent || '').trim().split(/\s+/).length;
      if (n < 3 || n > 16 || r.top < 110 || r.top > H - 160 || r.height > fs * 2.2 || r.width < 140) continue;
      c.push(e);
    }
    return c.length ? pick(c) : null;
  }
  const gear5 = () => ({
    name: 'gear5',
    start() {
      neutral();
      const e = pickLine(); if (!e || B.mode !== 'ground') { this.done = true; return; }
      const text = e.textContent, h0 = e.getBoundingClientRect().height; e.__kz = text; e.textContent = '';
      const spans = [];
      for (const part of text.split(/(\s+)/)) { if (!part) continue; if (/^\s+$/.test(part)) e.appendChild(document.createTextNode(part)); else { const s = document.createElement('span'); s.className = 'kz-w'; s.textContent = part; e.appendChild(s); spans.push(s); } }
      if (e.getBoundingClientRect().height > h0 * 1.7) { e.textContent = text; delete e.__kz; this.done = true; return; }
      let left = 1e9, right = 0; const words = spans.map((s) => { const r = s.getBoundingClientRect(); left = Math.min(left, r.left); right = Math.max(right, r.right); s.style.transition = 'none'; return { s, ox: r.left, w: r.width }; });
      const dir = Math.random() < 0.5 ? 1 : -1;
      line = { el: e, words, dir, left, right, stars: null };
      this.ph = 'go'; this.plant = dir > 0 ? left + 10 * S : right - 10 * S;
      const top = e.getBoundingClientRect().top;
      launchTo(this.plant, top); this.ph = 'jump';
    },
    update(t) {
      if (this.done || !line) return true;
      const L = line, r = L.el.getBoundingClientRect();
      if (t - this.t0 > 12000 || r.top < 60 || r.top > H - 60) { restoreLine(); if (B.mode === 'ground' && B.surf) { B.surf = null; B.mode = 'air'; } return true; }
      if (this.ph === 'jump') {
        const feet = B.y + FOOT * S, pf = this.pf == null ? feet : this.pf; this.pf = feet;
        const onIt = (B.mode === 'ground' && B.surf && B.surf.el === L.el) || (B.mode === 'air' && B.vy > 0 && pf <= r.top + 2 && feet >= r.top);
        if (onIt) {
          B.y = r.top - FOOT * S;
          B.mode = 'ground'; B.surf = { el: L.el, side: L.dir > 0 ? -1 : 1, line: true }; B.surfDX = L.dir > 0 ? (this.plant - (r.left + 5 * S)) : (this.plant - (r.right - 5 * S));
          B.vy = 0; kick(-3); this.ph = 'churn'; this.k = t; B.face = L.dir;
        } else if (B.mode === 'ground' && t - this.t0 > 1500) { restoreLine(); return true; }
        return false;
      }
      if (this.ph === 'churn') {
        const dur = 1500, k = Math.min(1, (t - this.k) / dur), sc = (1 - Math.pow(1 - k, 3)) * ((L.right - L.left) + W * 0.6 + 170);
        B.face = L.dir; B.want = 0; B.vx = L.dir * 400; B.walkPh += 0.9; B.eye = 3; B.pose = 'flail'; B.rot = L.dir * 0.2;
        let used = 0, left = 0;
        for (const wd of L.words) {
          if (L.dir > 0) { const nat = wd.ox - sc, slot = 6 + used, tg = Math.max(nat, slot); if (nat > slot + 0.5) left++; wd.s.style.transform = `translateX(${(tg - wd.ox).toFixed(1)}px)`; }
          else { const nat = wd.ox + sc, slot = W - 6 - used - wd.w, tg = Math.min(nat, slot); if (nat < slot - 0.5) left++; wd.s.style.transform = `translateX(${(tg - wd.ox).toFixed(1)}px)`; }
          used += wd.w * 0.5;
        }
        if (Math.random() < 0.3) dust(B.x - L.dir * 12, B.y + FOOT * S, 1, -L.dir);
        if (left === 0 || k >= 1) {
          for (const wd of L.words) { wd.s.style.transition = ''; wd.s.style.transform = ''; }
          B.surf = null; B.mode = 'air'; B.vx = L.dir * 2600; B.vy = -260; B.rv = 0; B.eye = 0; B.mouth = 2; B.mouthO = 1; this.ph = 'fly'; say(pick(['gear 5!', 'boing!']));
        }
        return false;
      }
      if (this.ph === 'fly') {
        const wall = L.dir > 0 ? B.x >= W - 17 * S : B.x <= 17 * S;
        if (wall) {
          this.ph = 'bonk'; this.k = t; kick(-9); B.vx = -L.dir * 180; B.eye = 2; B.mouth = 3;
          const st = document.createElement('div'); st.className = 'kz-stars'; for (let i = 0; i < 4; i++) { const s = document.createElement('span'); s.textContent = '★'; s.style.transform = `rotate(${i * 90}deg) translate(0,-16px)`; st.appendChild(s); } fx.appendChild(st); L.stars = st;
          quake(B.x, B.y, 0.8);
        }
        return B.mode === 'ground' && t - this.t0 > 3000;
      }
      if (this.ph === 'bonk') {
        if (L.stars) { const hp2 = l2w(0, -24); L.stars.style.left = hp2[0] + 'px'; L.stars.style.top = hp2[1] + 'px'; }
        if (B.mode === 'ground' && t - this.k > 1400) { restoreLine(); return true; }
      }
    },
    end() { restoreLine(); B.pose = 'rest'; B.eye = 0; B.mouth = 0; if (B.surf && B.surf.line) { B.surf = null; B.mode = 'air'; } },
  });

  /* the wind takes the hat — stretch and catch it */
  function blowHat(vx, vy) {
    if (B.hatFree || B.hatToss) return;
    const hp2 = l2w(B.faceS * 1.2, -13.6);
    B.hatFree = { x: hp2[0], y: hp2[1], vx, vy, rot: B.rot, rv: rnd(-9, 9), held: false };
  }
  const chaseHat = () => ({
    name: 'chase',
    start() {
      neutral(); B.eye = 3; B.mouth = 3; B.mouthO = 0.8; say(pick(['my hat!', 'hey!', '!!']));
      const h = B.hatFree; if (!h) { this.done = true; return; }
      this.arm = armFor(frontSide()); this.go = now() + 650;
    },
    update(t) {
      if (this.done) return true;
      const h = B.hatFree; if (!h) return true;
      if (this.go && t > this.go) {
        this.go = 0; B.face = sgn(h.x - B.x); this.arm = armFor(frontSide());
        reach(this.arm, () => (B.hatFree ? [B.hatFree.x, B.hatFree.y] : null), 2200, () => {
          if (!B.hatFree) return; B.hatFree.held = true; this.arm.carry = (x, y) => { if (B.hatFree) { B.hatFree.x = x; B.hatFree.y = y; } }; letGo(this.arm);
        });
      }
      lookAt = [h.x, h.y]; lookLock = now() + 300;
      if (h.held && this.arm.mode === 'pose') { this.arm.carry = null; B.hatFree = null; hatKick(6); kick(-3); B.eye = 1; B.mouth = 1; this.k = t; return false; }
      if (t - this.t0 > 6000) { B.hatFree = null; return true; }
    },
    end() { if (this.arm) { this.arm.carry = null; letGo(this.arm); } B.hatFree = null; B.eye = 0; B.mouth = 0; },
  });

  /* ───────────────────────── mini gears (a tribute) ───────────────────────── */
  function myGutter() { let best = null, bd = 1e9; for (const z of gutters()) { const d = B.x < z[0] ? z[0] - B.x : B.x > z[1] ? B.x - z[1] : 0; if (d < bd) { bd = d; best = z; } } return best; }
  /* gear 2: pump, flush red, steam, jet dash + jet pistol */
  const gear2 = () => ({
    name: 'gear2',
    start() { neutral(); this.ph = 'pump'; this.k = now(); this.p = 0; },
    update(t) {
      const e = t - this.k;
      if (this.on && Math.random() < 0.35) steam(1);
      if (this.ph === 'pump') {
        B.eye = 3; B.walkPh += 0.5;
        if (e > 420 && !this.on) { this.on = true; gearTint(0.96, 0.36, 0.42, 0.55); steam(5); say('gear 2', 'kz-big'); }
        if (t > this.p) { this.p = t + 160; kick(-4.5); }
        if (e > 800) {
          const z = myGutter(), lo = z ? z[0] : Math.max(24, B.x - 90), hi = z ? z[1] : Math.min(W - 80, B.x + 90);
          this.tx = B.x - lo > hi - B.x ? lo : hi; this.ph = 'jet'; this.k = t; B.eye = 0; B.mouth = 1;
        }
      } else if (this.ph === 'jet') {
        const dx = this.tx - B.x; B.want = sgn(dx) * 950 * S; B.face = sgn(dx);
        if (Math.random() < 0.8) speedLine(); if (Math.random() < 0.3) dust(B.x - B.face * 10, B.y + FOOT * S, 1, -B.face);
        if (Math.abs(dx) < 12 || e > 1500) {
          B.want = 0; B.vx = 0; kick(-5); this.ph = 'pistol'; this.k = t;
          const a = armFor(frontSide()), up = [B.x + B.face * 30 * S, B.y - 170 * S]; this.arm = a;
          reach(a, () => up, 5200, () => { say('jet pistol!'); dust(up[0], up[1], 4); letGo(a); });
        }
      } else if (this.ph === 'pistol') { if (e > 700) { this.ph = 'cool'; this.k = t; GT.tint = 0; } }
      else if (e > 900) return true;
    },
    end() { B.want = 0; gearReset(); if (this.arm) letGo(this.arm); B.eye = 0; B.mouth = 0; },
  });
  /* gear 3: bite thumb, blow up a giant fist, punch, then shrink to chibi */
  const gear3 = () => ({
    name: 'gear3',
    start() { neutral(); this.ph = 'bite'; this.k = now(); B.pose = 'bite'; B.mouth = 2; B.mouthO = 0.5; this.ai = frontSide() < 0 ? 0 : 1; },
    update(t) {
      const e = t - this.k, A = this.ai ? 'a1' : 'a0', Hd = this.ai ? 'h1' : 'h0';
      if (this.ph === 'bite') { if (e > 450) { this.ph = 'blow'; this.k = t; B.pose = 'giant'; B.mouth = 3; B.mouthO = 1; say('gear 3', 'kz-big'); } }
      else if (this.ph === 'blow') {
        GT[A] = 5; GT[Hd] = 13.5; if (Math.random() < 0.25) steam(1);
        if (e > 750) {
          this.ph = 'punch'; this.k = t; B.mouth = 2; B.mouthO = 0.8;
          const z = myGutter(), room = B.face > 0 ? (z ? z[1] : W - 80) - B.x : B.x - (z ? z[0] : 20);
          const tgt = room > 140 ? [B.x + B.face * Math.min(260, room), B.y - 30 * S] : [B.x + B.face * 10, B.y - 230 * S];
          const quiet = readingMode(); this.arm = arms[this.ai];
          reach(this.arm, () => tgt, 2600, () => { say('gigant pistol!'); kick(-4); dust(tgt[0], tgt[1], 6); if (!quiet) quake(tgt[0], tgt[1], 0.7); letGo(this.arm); });
        }
      } else if (this.ph === 'punch') { if (this.arm.mode === 'pose' && e > 300) { this.ph = 'deflate'; this.k = t; GT[A] = 2.1; GT[Hd] = 3.1; steam(3); } }
      else if (this.ph === 'deflate') { if (e > 450) { this.ph = 'chibi'; this.k = t; GT.gs = 0.55; say('poof'); steam(4); B.eye = 1; B.mouth = 2; B.mouthO = 0.6; } }
      else if (this.ph === 'chibi') { B.want = e < 1800 ? Math.sin(e / 260) * 40 : 0; if (e > 2400) { this.ph = 'back'; this.k = t; GT.gs = 1; kick(-6); } }
      else if (e > 500) return true;
    },
    end() { B.want = 0; gearReset(); if (this.arm) letGo(this.arm); B.pose = 'rest'; B.eye = 0; B.mouth = 0; },
  });
  /* gear 4: bulk up (boundman), steam, bounce bounce, then deflate exhausted */
  const gear4 = () => ({
    name: 'gear4',
    start() { neutral(); this.ph = 'bite'; this.k = now(); B.pose = 'bite'; },
    update(t) {
      const e = t - this.k;
      if (this.ph === 'bite') {
        if (e > 400) { this.ph = 'pump'; this.k = t; Object.assign(GT, { bulk: 1, a0: 3.4, h0: 5.4, a1: 3.4, h1: 5.4 }); gearTint(0.5, 0.08, 0.1, 0.28); B.pose = 'boundman'; B.eye = 3; steam(6); say('gear 4', 'kz-big'); }
      } else if (this.ph === 'pump') { if (Math.random() < 0.5) steam(1); if (e > 600) { this.ph = 'bounce'; this.k = t; this.n = 0; B.eye = 0; B.mouth = 1; } }
      else if (this.ph === 'bounce') {
        if (Math.random() < 0.3) steam(1);
        if (B.mode === 'ground' && t > (this.nx || 0)) {
          if (this.n >= 4) { this.ph = 'deflate'; this.k = t; gearReset(); steam(8); say('pshhh…'); B.eye = 2; B.pose = 'sleep'; B.sit = 1; return false; }
          this.n++; kick(-5); this.nx = t + 130; this.go = t + 110;
        }
        if (this.go && t > this.go && B.mode === 'ground') { this.go = 0; B.vy = -620; B.vx = rnd(-40, 40); B.mode = 'air'; B.surf = null; kick(8); if (this.n === 1) say('boing!'); }
      } else if (this.ph === 'deflate') { if (e > 1600) return true; }
    },
    end() { gearReset(); B.pose = 'rest'; B.eye = 0; B.mouth = 0; B.sit = 0; },
  });
  /* gear 5 (Nika): the drums of liberation, white flame-hair, cloud collar, red glowing eyes, a huge grin,
     toon physics (eyes pop, flips), the rubber world — and afterwards he's shrivelled and exhausted */
  const toon = () => ({
    name: 'toon',
    start() { this.n = 0; say('ha ha ha!'); B.eye = 0; B.mouth = 2; B.pose = 'wide'; },
    update(t) {
      B.mouthO = 0.6 + Math.sin(t / 60) * 0.4;
      if (B.mode === 'ground' && t > (this.nx || 0)) { if (this.n >= 3) return true; this.n++; this.nx = t + 220; B.vy = -560; B.mode = 'air'; B.surf = null; B.rv = (Math.random() < 0.5 ? -1 : 1) * Math.PI * 2 / 0.45; kick(10); }
    },
    end() { B.pose = 'rest'; B.mouth = 0; B.eye = 0; },
  });
  const g5laugh = () => ({                         // laughing so hard his eyes pop out of his head
    name: 'g5laugh',
    start() { B.pose = 'wide'; B.mouth = 2; B.mouthO = 1; B.eye = 0; say('ha ha ha ha!', 'kz-big'); this.k = 0; },
    update(t) {
      const e = t - this.t0; B.mouthO = 0.75 + Math.sin(t / 55) * 0.25;
      if (t > this.k) { this.k = t + 90; kick(Math.random() < 0.5 ? 2.6 : -2.6); }
      GT.pop = e > 380 && e < 1250 ? 1.3 : 0; if (e > 380 && !this.p) { this.p = 1; kick(5); }
      return e > 1650;
    },
    end() { GT.pop = 0; },
  });
  const g5revert = () => ({                        // the price of Nika: shrivelled, tiny, exhausted
    name: 'g5revert',
    start() { gearReset(); GT.gs = 0.8; steam(8); say('pshhh…'); B.eye = 2; B.pose = 'sleep'; B.sit = 1; B.mouth = 3; B.mouthO = 0.3; this.old = true; },
    update(t) {
      const e = t - this.t0;
      if (e > 900 && !this.z) { this.z = 1; say('…so hungry'); }
      if (e > 2300 && this.old) { this.old = false; GT.gs = 1; kick(-5); B.eye = 1; B.sit = 0; B.pose = 'rest'; B.mouth = 1; }
      return e > 2800;
    },
    end() { GT.gs = 1; B.eye = 0; B.mouth = 0; B.sit = 0; B.pose = 'rest'; },
  });
  const gear5x = (rubberRun) => ({
    name: 'gear5x',
    start() { neutral(); this.bi = 0; this.beats = [0, 260, 820, 1080, 1640, 1900]; B.mouth = 1; },
    update(t) {
      const e = t - this.t0;
      if (this.bi < this.beats.length && e > this.beats[this.bi]) {        // ba-dum … ba-dum … — his heartbeat is a drum
        this.bi++; kick(-5.5); hatKick(3); say(this.bi % 2 ? 'don' : 'don!', 'kz-drum');
        GT.hair = Math.min(0.35, this.bi * 0.07); if (!readingMode() && this.bi % 2 === 0) quake(B.x, B.y, 0.2);
      }
      if (e > 2150 && !this.aw) {
        this.aw = 1; Object.assign(GT, { hair: 1, g5: 1 }); gearTint(1, 1, 1, 1); say('gear 5!', 'kz-big'); B.pose = 'wide'; B.mouth = 2; B.mouthO = 1; kick(9); steam(6);
      }
      if (e > 2700) { this.pushed = true; const seq = [g5laugh(), toon()]; if (rubberRun && pickLine()) seq.push(gear5()); seq.push(g5revert()); queue.push(...seq); return true; }
    },
    end() { if (!this.pushed) gearReset(); },
  });
  function gearAct(n, invited) { return n === 2 ? gear2() : n === 3 ? gear3() : n === 4 ? gear4() : gear5x(invited || !readingMode()); }
  function runGear(n, invited) { queue.length = 0; const a = gearAct(n, invited); if (B.mode === 'ground' && !drag) run(a); else queue.push(a); }
  function readingMode() { if (!IS_ARTICLE) return false; const p = articleProgress(); return p > 0.03 && p < 0.97; }

  /* ───────────────────────── brain ───────────────────────── */
  let omReadyAt = now() + 25000, bigReadyAt = now() + 14000, swingReadyAt = now() + 8000, rocketReadyAt = now() + 9000, hatReadyAt = now() + 20000;
  const busy = () => now() - lastScrollAt < 2600;
  function think() {
    const t = now(), idleFor = t - Math.max(lastScrollAt, lastMouseAt, lastInputAt);
    if (B.hatFree) return run(chaseHat());
    if (B.mode !== 'ground') return run(wait(150));
    if (pendingHello) { const h = pendingHello; pendingHello = null; return run(wave(h, 2200)); }
    if (MOBILE()) {
      const r = Math.random();
      if (r < 0.55) return run(idle(rnd(2500, 6000)));
      if (r < 0.85) return run(walkTo(rnd(14, 64)));
      if (t > omReadyAt && !busy()) { omReadyAt = t + rnd(60000, 120000); return run(meditate(rnd(12000, 20000))); }
      return run(cheer());
    }
    if (idleFor > 18000 && idleFor < 45000 && t > omReadyAt && !B.surf) { omReadyAt = t + rnd(80000, 140000); return run(meditate(rnd(14000, 22000))); }
    if (idleFor > 45000) return run(sleep(rnd(30000, 90000)));
    const r = Math.random(), sel = String(getSelection && getSelection()).trim(), reading = readingMode();
    const tipFree = () => { if (!reading) return true; const tp = barTip(), m = (document.querySelector('main') || document.body).getBoundingClientRect(); return tp && (tp[0] < m.left - 30 || tp[0] > m.right + 30); };
    if (busy() && t > swingReadyAt && barOK() && r < (reading ? 0.1 : 0.4) && tipFree()) { swingReadyAt = t + (reading ? rnd(150000, 300000) : rnd(45000, 80000)); return run(swing()); }
    if (t > bigReadyAt && !busy() && !sel && r < (reading ? 0.15 : 0.4) && (!reading || t - startedAt > 60000)) {
      bigReadyAt = t + (reading ? rnd(120000, 240000) : rnd(30000, 60000));
      const r2 = Math.random();
      if (reading) return run(gearAct(r2 < 0.3 ? 2 : r2 < 0.6 ? 3 : r2 < 0.85 ? 4 : 5, false));   // gutter-only tricks, never the text
      if (r2 < 0.3) return run(pluck());
      if (r2 < 0.5) return run(gear5x(true));
      if (r2 < 0.65) return run(rocket());
      return run(gearAct(pick([2, 3, 4])));
    }
    if (reading) {                                   // quiet companion: stay in the gutter, be still
      if (B.surf) { const z = myGutter(); return run(hopTo({ x: z ? rnd(z[0], z[1]) : (B.x < W / 2 ? 40 : W - 100), y: floorY() })); }
      if (r < 0.25) { const z = myGutter(); return run(walkTo(z ? rnd(z[0], z[1]) : B.x)); }
      if (r < 0.35 && !busy() && t > omReadyAt) { omReadyAt = t + rnd(60000, 120000); return run(meditate(rnd(12000, 20000))); }
      if (r < 0.75) return run(idle(rnd(4000, 9000)));
      return run(sit(rnd(5000, 10000)));
    }
    if (B.surf) {
      if (r < 0.45) return run(sit(rnd(3000, 7000)));
      if (r < 0.8) return run(hopTo({ x: clamp(B.x + rnd(-120, 120), 30, W - 30), y: floorY() }));
      const p = pick(goodPerches()); if (p) return run(hopTo(p));
      return run(idle(1500));
    }
    if (r < 0.34) return run(walkTo(gutterX()));
    if (r < 0.5 && t > rocketReadyAt) {
      const near = goodPerches().filter((p) => { const q = perchPoint(p); return Math.abs(q[0] - B.x) < 260 && B.y - q[1] < 190; });
      if (near.length) return run(hopTo(pick(near)));
      rocketReadyAt = t + rnd(18000, 35000); if (!busy()) return run(rocket());
    }
    if (r < 0.62 && !busy() && t > omReadyAt) { omReadyAt = t + rnd(60000, 120000); return run(meditate(rnd(12000, 20000))); }
    if (r < 0.75) return run(idle(rnd(1600, 4200)));
    if (r < 0.85) return run(sit(rnd(2500, 5000)));
    if (r < 0.93) return run(laugh(900));
    return run(wave(null, 1200));
  }

  /* ───────────────────────── progress milestones ───────────────────────── */
  function articleProgress() {
    const a = document.querySelector('.article-content'); if (!a) return -1;
    const r = a.getBoundingClientRect(); return clamp((H - r.top) / Math.max(1, r.height), 0, 1);
  }
  const ms = { half: false, end: false };
  function readMinutes() { const m = (document.querySelector('.read-time') || {}).textContent || ''; const n = parseInt(m.replace(/\D+/g, ''), 10); return n || 5; }
  function milestones() {
    if (!IS_ARTICLE) return;
    const p = articleProgress(); if (p < 0) return;
    const a = document.querySelector('.article-content'); if (a.getBoundingClientRect().height < H * 2) return;
    const free = !act || ['idle', 'walk', 'sit', 'wave', 'laugh', 'sleep'].includes(act.name) || (act.name === 'meditate' && now() - act.t0 > 10000);
    if (!ms.half && p > 0.5 && free && B.mode === 'ground') { ms.half = true; run(cheer('halfway! ⛵')); }
    if (!ms.end && p > 0.985 && free && B.mode === 'ground') {
      ms.end = true;
      const spent = (now() - startedAt) / 1000, tldr = spent < Math.max(20, readMinutes() * 60 * 0.25);
      run(finale(tldr));
    }
  }

  /* ───────────────────────── input ───────────────────────── */
  addEventListener('mousemove', (e) => {
    mouseX = e.clientX; mouseY = e.clientY; lastMouseAt = now();
    if (act && act.name === 'sleep' && !act.wake && hyp(e.clientX - B.x, e.clientY - B.y) < 140) act.wake = now();
  }, { passive: true });
  addEventListener('scroll', () => { lastScrollAt = now(); if (act && act.name === 'sleep' && !act.wake && now() - act.t0 > 3000) act.wake = now(); }, { passive: true });
  addEventListener('keydown', () => { lastInputAt = now(); }, { passive: true });

  let pets = 0, petAt = 0, lastTapAt = 0, petTimer = 0, gearIdx = 0;
  function pet() {
    const t = now(); pets = t - petAt < 4000 ? pets + 1 : 1; petAt = t;
    if (act && act.name === 'sleep') { act.wake = t; return; }
    if (act && act.name === 'meditate' && !act.out) { act.shh = (act.shh || 0) + 1; say(act.shh >= 3 ? 'ok, ok…' : 'shh… ☮'); if (act.shh >= 3) act.wake = true; return; }
    if (pets >= 4) { pets = 0; run(love()); return; }
    run(laugh(1000, pick(['hehe', 'hi!', 'ha ha!', '♪']))); say('♥', 'kz-heart');
    if (B.mode === 'ground') { B.vy = -380; B.mode = 'air'; B.surf = null; kick(6); }
  }
  hit.addEventListener('pointerdown', (e) => {
    e.preventDefault(); lastInputAt = now();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, ox: B.x - e.clientX, oy: B.y - e.clientY, moved: false, hist: [] };
    try { hit.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
  });
  hit.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.x = e.clientX; drag.y = e.clientY; drag.hist.push([now(), e.clientX, e.clientY]); if (drag.hist.length > 8) drag.hist.shift();
    if (!drag.moved && hyp(e.clientX - drag.sx, e.clientY - drag.sy) > 5) {
      drag.moved = true; queue.length = 0; run(null); gearReset(); resetArms(); neutral(); restoreLine(); dropWord();
      B.mode = 'held'; B.surf = null; B.pose = 'flail'; B.eye = 3; B.mouth = 3; B.mouthO = 0.7; root.classList.add('kz-held');
      if (Math.random() < 0.5) say(pick(['hey!', 'whoa', 'wheee']));
    }
  });
  function release(e) {
    if (!drag) return;
    try { hit.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
    const d = drag; drag = null; root.classList.remove('kz-held');
    if (!d.moved) {                                   // tap = say hi; double-tap = next gear
      if (now() - lastTapAt < 330) { clearTimeout(petTimer); lastTapAt = 0; runGear([2, 3, 4, 5][gearIdx++ % 4], true); }
      else { lastTapAt = now(); clearTimeout(petTimer); petTimer = setTimeout(pet, 330); }
      return;
    }
    run(wait(250));
    let vx = B.vx, vy = B.vy;
    if (d.hist.length >= 2) { const a = d.hist[0], b = d.hist[d.hist.length - 1], dt = Math.max(16, b[0] - a[0]) / 1000; vx = (b[1] - a[1]) / dt; vy = (b[2] - a[2]) / dt; }
    const sp = hyp(vx, vy), k = sp > 3200 ? 3200 / sp : 1;
    B.vx = vx * k; B.vy = vy * k; B.mode = 'air'; B.rv = clamp(B.vx * 0.006, -14, 14); B.pose = sp > 900 ? 'up' : 'rest'; B.eye = sp > 900 ? 1 : 0; B.mouth = sp > 900 ? 2 : 0; B.mouthO = 1;
    if (sp > 1400) say(pick(['wheeee!', 'freedom!', 'yahoo!']));
  }
  hit.addEventListener('pointerup', release);
  hit.addEventListener('pointercancel', release);

  let selT = 0, selReadyAt = 0;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selT);
    selT = setTimeout(() => {
      if (MOBILE() || drag || now() < selReadyAt) return;
      const s = getSelection(); if (!s || s.isCollapsed || !s.rangeCount) return;
      const txt = s.toString().trim(); if (txt.length < 2 || txt.length > 90) return;
      const r = s.getRangeAt(0).getBoundingClientRect(); if (!r.width) return;
      selReadyAt = now() + 7000; lookAt = [r.left + r.width / 2, r.top + r.height / 2]; lookLock = now() + 2500;
      const short = txt.length > 16 ? txt.slice(0, 15) + '…' : txt;
      say(pick([`“${short}”?`, 'ooh', 'noted!', 'hmm…'])); B.eye = 0;
    }, 650);
  });
  let copyAt = 0;
  function copied() { const t = now(); if (t - copyAt < 1500) return; copyAt = t; if (!MOBILE() && B.mode === 'ground') { B.vy = -420; B.mode = 'air'; B.surf = null; kick(6); } say('✓ copied'); }
  document.addEventListener('copy', copied);
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('.copy-btn,.share-copy-btn')) copied(); });

  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = now(); return; }
    if (hiddenAt && now() - hiddenAt > 30000 && B.mode === 'ground') run(wave(pick(['oh! you’re back', 'welcome back!']), 2000));
  });

  /* ───────────────────────── render ───────────────────────── */
  function render() {
    gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!B.visible) return;
    const sqR = B.sq + (B.mode === 'ground' ? Math.sin(T * 2.3) * 0.016 : 0);
    const sx = (1 - sqR * 0.55) * (1 + 0.28 * GV.bulk), sy = (1 + sqR) * (1 + 0.08 * GV.bulk);
    let x0 = B.x - 40 * S, x1 = B.x + 40 * S, y0 = B.y - 52 * S, y1 = B.y + 40 * S;
    const grow = (x, y, m) => { if (x - m < x0) x0 = x - m; if (x + m > x1) x1 = x + m; if (y - m < y0) y0 = y - m; if (y + m > y1) y1 = y + m; };
    for (let i = 0; i < 7; i++) { fA0[i * 2] = arms[0].pts[i].x; fA0[i * 2 + 1] = arms[0].pts[i].y; fA1[i * 2] = arms[1].pts[i].x; fA1[i * 2 + 1] = arms[1].pts[i].y; grow(fA0[i * 2], fA0[i * 2 + 1], (GV.h0 + 3) * S); grow(fA1[i * 2], fA1[i * 2 + 1], (GV.h1 + 3) * S); }
    for (let i = 0; i < 8; i++) { fSc[i * 2] = scarf[i].x; fSc[i * 2 + 1] = scarf[i].y; grow(scarf[i].x, scarf[i].y, 6); }
    for (let k = 0; k < 2; k++) for (let j = 0; j < 4; j++) fLeg[k * 4 + j] = legs[k][j];
    // hat
    let hx, hy, hr, hs = 1, hatOn = 1;
    if (B.hatFree) { hx = B.hatFree.x; hy = B.hatFree.y; hr = B.hatFree.rot; }
    else {
      const p = l2w(B.faceS * 1.2, -13.6 + B.hatSlide * 10); hx = p[0]; hy = p[1]; hr = B.rot + B.hatRot + B.hatSlide * 0.25 * B.faceS;
      if (GV.g5 > 0.02) { const k = Math.min(1, GV.g5 * 1.2), bk = l2w(-B.faceS * 15, 3); hx = lerp(hx, bk[0], k); hy = lerp(hy, bk[1], k); hr = lerp(hr, B.rot - B.faceS * 1.25, k); }
      if (B.hatToss) {
        const e = (now() - B.hatToss.t0) / 1000, dur = 1.0;
        if (e >= dur) { B.hatToss = null; hatKick(7); kick(-3); }
        else { hy -= Math.sin((e / dur) * Math.PI) * 110 * S; hr += (e / dur) * Math.PI * 4; }
      }
    }
    grow(hx, hy, 27 * S);
    if (GV.hair > 0.01) { const c = l2w(0, -26); grow(c[0], c[1], 48 * S); }
    if (auraA > 0.005) { const c = l2w(0, 2); grow(c[0], c[1], 60 * S); }
    const fy = floorY(), grounded = B.mode === 'ground' && !B.surf;
    const shH = Math.max(0, fy - (B.y + FOOT * S));
    const shA = B.mode === 'hang' || B.mode === 'held' ? 0.07 * clamp(1 - shH / 600, 0, 1) : (grounded ? 0.13 : 0.13 * clamp(1 - shH / 260, 0, 1));
    const shX = B.x, shY = B.surf ? surfaceY() - 1 : fy - 1, shW = 15 * S * (1 - clamp(shH / 400, 0, 0.5)) * (1 - B.lev * 0.022);
    if (shA > 0.005) grow(shX, shY, shW + 4);
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W, x1); y1 = Math.min(H, y1);
    if (x1 <= x0 || y1 <= y0) return;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.floor(x0 * DPR), Math.floor((H - y1) * DPR), Math.ceil((x1 - x0) * DPR), Math.ceil((y1 - y0) * DPR));
    gl.uniform2f(U.uRes, canvas.width, canvas.height); gl.uniform1f(U.uDpr, DPR); gl.uniform1f(U.uS, S);
    gl.uniform1f(U.uSeed, Math.floor(T * 9) % 5);
    gl.uniform3fv(U.uInk, INK); gl.uniform3fv(U.uPaper, PAPER); gl.uniform3fv(U.uRed, RED);
    gl.uniform4f(U.uBody, B.x, B.y, B.rot, B.faceS);
    gl.uniform4f(U.uSq, sx, sy, B.blush, 0);
    const g5on = GV.g5 > 0.5;
    gl.uniform4f(U.uEye, eyeLX, eyeLY, B.blink, g5on && (B.eye === 1 || B.eye === 3) ? 0 : B.eye);
    gl.uniform4f(U.uMouth, g5on && (B.mouth === 2 || B.mouth === 1) ? 4 : B.mouth, g5on ? Math.max(B.mouthO, 0.7) : B.mouthO, 0, 0);
    gl.uniform4f(U.uHat, hx, hy, hr, hs);
    gl.uniform4f(U.uShadow, shX, shY, shW, shA);
    gl.uniform4f(U.uMisc, REDUCE ? 0 : 1, hatOn, GV.g5 > 0.5 && !B.hatFree ? 1 : 0, 0);
    { const c = l2w(0, 2), R = (46 + 5 * auraP + Math.sin(T * 1.3) * 1.5) * S; gl.uniform4f(U.uAura, c[0], c[1], R, auraA * (0.85 + 0.15 * auraP)); }
    gl.uniform4f(U.uTint, GV.tr, GV.tg, GV.tb, GV.tint); gl.uniform4f(U.uGear, GV.hair, GV.g5, T, GV.pop); gl.uniform4f(U.uArmR, GV.a0, GV.h0, GV.a1, GV.h1);
    gl.uniform2fv(U.uA0, fA0); gl.uniform2fv(U.uA1, fA1); gl.uniform2fv(U.uSc, fSc); gl.uniform4fv(U.uLeg, fLeg);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* ───────────────────────── main loop ───────────────────────── */
  let eyeLX = 0, eyeLY = 0, blinkAt = now() + 2000, blinkT = -1, lastT = now(), msAt = 0, gustHold = 0;
  function frame(tNow) {
    const dt = Math.min(1 / 30, Math.max(0.001, (tNow - lastT) / 1000)); lastT = tNow; T += dt;
    const sy = scrollY; scrollV += ((sy - lastSY) / dt - scrollV) * Math.min(1, dt * 9); lastSY = sy;
    const wind = clamp((Math.abs(scrollV) - 900) / 2600, 0, 1);
    if (MOBILE()) sink += ((busy() ? 44 : 12) - sink) * Math.min(1, dt * 7);   // duck while you scroll, peek when you stop

    if (B.mode === 'ground') groundStep(dt); else if (B.mode === 'air') airStep(dt); else if (B.mode === 'hang') hangStep(dt); else if (B.mode === 'held') heldStep(dt);

    // springs: squash, hat wobble, facing
    if (B.mode !== 'held') { B.sqv += (-400 * B.sq - 13 * B.sqv) * dt; B.sq = clamp(B.sq + B.sqv * dt, -0.42, 0.42); }
    B.hatRv += (-B.hatRot * 140 - B.hatRv * 7) * dt; B.hatRot = clamp(B.hatRot + B.hatRv * dt, -0.7, 0.7);
    if (B.mode === 'air' || B.mode === 'hang') { if (Math.abs(B.vx) > 40) B.face = sgn(B.vx); }
    B.faceS += (B.face - B.faceS) * Math.min(1, dt * 11);

    // wind from scrolling
    const calm = !act || ['idle', 'walk', 'sit'].includes(act.name);
    if (wind > 0.35 && calm && B.mode === 'ground') {
      B.eye = 3; B.pose = 'hat'; gustHold += dt; hatKick((Math.random() - 0.5) * wind * 8);
      if (wind > 0.92 && gustHold > 0.25 && now() > hatReadyAt && !MOBILE()) { hatReadyAt = now() + 40000; blowHat(B.x < W / 2 ? rnd(250, 450) : rnd(-450, -250), -sgn(scrollV) * 800 - 300); run(chaseHat()); }
    } else if (gustHold > 0 && calm) { gustHold = 0; B.eye = 0; B.pose = 'rest'; kick(-3); }
    if (B.hatFree && !B.hatFree.held) {
      const h = B.hatFree; h.vy += 520 * dt; h.vy -= clamp(scrollV, -3000, 3000) * 0.9 * dt; h.vx += Math.sin(T * 3) * 200 * dt; h.vx *= 1 - 0.9 * dt; h.vy *= 1 - 0.9 * dt;
      h.x += h.vx * dt; h.y += h.vy * dt; h.rot += h.rv * dt;
      if (h.x < 14 || h.x > W - 14) { h.vx *= -0.6; h.x = clamp(h.x, 14, W - 14); }
      if (h.y < 20) { h.y = 20; h.vy = Math.abs(h.vy) * 0.5; }
      if (h.y > floorY() - 4) { h.y = floorY() - 4; h.vy = 0; h.vx *= 0.8; h.rv *= 0.8; }
    }

    stepArm(arms[0], dt); stepArm(arms[1], dt); stepScarf(dt); stepLegs();

    // eyes: look at cursor / act target
    let lt = lookAt; if (now() - lastMouseAt < 2500 && now() > lookLock) lt = [mouseX, mouseY];
    let lx = 0, ly = 0;
    if (lt) { const c = Math.cos(-B.rot), s = Math.sin(-B.rot), dx = lt[0] - B.x, dy = lt[1] - B.y, d = hyp(dx, dy) || 1, k = Math.min(1, d / 160); lx = ((c * dx - s * dy) / d) * 1.7 * k; ly = ((s * dx + c * dy) / d) * 1.3 * k; }
    eyeLX += (lx - eyeLX) * Math.min(1, dt * 12); eyeLY += (ly - eyeLY) * Math.min(1, dt * 12);
    // blink
    const tn = now();
    if (blinkT < 0 && tn > blinkAt) { blinkT = tn; blinkAt = tn + rnd(2200, 5600) + (Math.random() < 0.15 ? -1900 : 0); }
    if (blinkT >= 0) { const e = (tn - blinkT) / 140; B.blink = e >= 1 ? 1 : Math.abs(1 - 2 * e); if (e >= 1) blinkT = -1; } else B.blink = 1;

    // brain
    for (const k of ['tint', 'hair', 'g5', 'bulk', 'a0', 'h0', 'a1', 'h1']) GV[k] += (GT[k] - GV[k]) * Math.min(1, dt * 7);
    GV.pop += (GT.pop - GV.pop) * Math.min(1, dt * 18);
    auraA += (auraT - auraA) * Math.min(1, dt * 2.2); auraP *= Math.exp(-dt * 1.6);
    GV.gs += (GT.gs - GV.gs) * Math.min(1, dt * 10); S = S0 * GV.gs;
    if (B.mode !== 'held') { if (!act || act.update(tn)) { if (act && act.end) act.end(); act = null; if (queue.length) run(queue.shift()); else think(); } }
    if (tn > msAt) { msAt = tn + 300; milestones(); }
    paintWord(); placeBanner();

    // hit target follows the body
    const hs = l2w(0, 0);
    hit.style.transform = `translate(${(hs[0] - 17 * S).toFixed(1)}px,${(hs[1] - 26 * S).toFixed(1)}px) scale(${S})`;
    hit.style.transformOrigin = '0 0';
    render();
    requestAnimationFrame(frame);
  }

  /* ───────────────────────── boot ───────────────────────── */
  addEventListener('resize', () => { resize(); B.x = clamp(B.x, 16 * S, W - 16 * S); if (B.mode === 'ground' && !B.surf) B.y = floorY() - FOOT * S; }, { passive: true });
  addEventListener('pagehide', () => { dropWord(); restoreLine(); });
  function placeAll() {
    for (const a of arms) for (const p of a.pts) { const w = l2w(a.side * 12, 8); p.x = p.px = w[0]; p.y = p.py = w[1]; }
    for (const p of scarf) { const w = l2w(-B.face * 10, 7); p.x = p.px = w[0]; p.y = p.py = w[1]; }
  }

  // entrance: drop in from the sky on a rubber arm... well, just drop in — freely.
  let visits = 1;
  try { if (!sessionStorage.getItem('kz-s')) { sessionStorage.setItem('kz-s', '1'); visits = +(localStorage.getItem('kz-v') || 0) + 1; localStorage.setItem('kz-v', String(visits)); } else visits = 0; } catch (e) { /* private mode */ }
  const g0 = gutters();
  B.x = g0.length ? rnd(g0[0][0], g0[0][1]) : rnd(40, 110);
  if (MOBILE()) B.x = rnd(16, 40);
  B.face = B.x < W / 2 ? 1 : -1; B.faceS = B.face;

  if (REDUCE) {                                   // still life: sit in the gutter, no motion
    B.y = floorY() - FOOT * S; placeAll(); for (let i = 0; i < 40; i++) { stepArm(arms[0], 1 / 60); stepArm(arms[1], 1 / 60); stepScarf(1 / 60); } stepLegs(); render();
    root.classList.add('kz-off');
    addEventListener('resize', render);
    return;
  }
  B.y = -60; B.mode = 'air'; B.vy = 200; B.pose = 'up'; B.eye = 1; B.rv = 0;
  placeAll();
  run({
    name: 'enter',
    update(t) {
      if (B.mode !== 'ground') return false;
      if (!this.l) { this.l = t; B.pose = 'rest'; B.eye = 0; }
      return t - this.l > 250;
    },
    end() { pendingHello = visits >= 2 ? (visits % 10 === 0 ? `visit #${visits}! ♥` : 'welcome back!') : visits === 1 ? 'hi! I’m Kaze' : null; },
  });

  // hash triggers (for demos): #pluck #rocket #swing #gear2 #gear3 #gear4 #gear5 #rubber #hat #finale #love #hello #om
  function fireHash() {
    const h = location.hash.slice(1); const go = () => {
      if (B.mode !== 'ground') return setTimeout(go, 300);
      ({ pluck: () => run(pluck()), play: () => run(pluck()), rocket: () => run(rocket()), swing: () => run(swing()), hang: () => run(swing()), gear2: () => runGear(2, true), gear3: () => runGear(3, true), gear4: () => runGear(4, true), gear5: () => runGear(5, true), rubber: () => run(gear5()),
        hat: () => { blowHat(B.x < W / 2 ? rnd(250, 450) : rnd(-450, -250), -1050); run(chaseHat()); }, finale: () => run(finale(false)), banner: () => run(finale(false)), love: () => run(love()), om: () => run(meditate(22000)), meditate: () => run(meditate(22000)), zen: () => run(meditate(22000)), hello: () => run(wave('hi! I’m Kaze', 2200)) }[h] || (() => {}))();
    };
    if (h) setTimeout(go, 900);
  }
  fireHash(); addEventListener('hashchange', fireHash);
  window.kaze = { run: (n) => { location.hash = ''; location.hash = n; }, state: () => ({ mode: B.mode, act: act && act.name, x: B.x, y: B.y }) };
  requestAnimationFrame((t) => { lastT = t; requestAnimationFrame(frame); });
})();
