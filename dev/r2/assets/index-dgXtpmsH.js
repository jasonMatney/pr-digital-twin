import{C as Ft,M as xt,A as Xe,G as St,a as ut,D as ce,p as Lt,B as Et,L as Le,d as ue,E as fe,F as ne,H as U,I as R,J as $,O as Te,K as ft,N as mt,P as Ze,Q as gt,T as we,U as wt,W as Pt,X as Rt,Y as Ee,Z as Bt,_ as Gt,q as Pe,$ as Re,a0 as _e,a1 as It,a2 as Be,a3 as Ue,a4 as ge,a5 as Ge,a6 as Ie,a7 as ht,a8 as $t,a9 as xe}from"./r2-B-MMsYtr.js";const Nt=`
uniform sampler2D tPhoto; uniform sampler2D tNorm; uniform sampler2D tOverlay;
uniform vec4 uOvXf; uniform float uHasPhoto; uniform float uOvOpacity; uniform float uRelief; uniform float uLod; uniform vec3 uTint;
uniform float uNight; uniform float uTintMode; uniform float uLightGain; uniform float uOvAbove; uniform sampler2D tDensity; uniform vec4 uDenXf;
varying float vH; varying vec2 vWxz;
vec3 gEmit; float gOvCov;
vec3 gToLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
float gHash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec3 gHypso(float h) {
  vec3 c;
  if (h < 0.0) {
    float d = -h;
    c = mix(vec3(0.60, 0.84, 0.90), vec3(0.27, 0.58, 0.80), smoothstep(0.0, 60.0, d));
    c = mix(c, vec3(0.09, 0.25, 0.52), smoothstep(60.0, 2000.0, d));
    c = mix(c, vec3(0.03, 0.08, 0.26), smoothstep(2000.0, 8000.0, d));
  } else {
    c = mix(vec3(0.13, 0.40, 0.20), vec3(0.36, 0.57, 0.25), smoothstep(0.0, 150.0, h));
    c = mix(c, vec3(0.78, 0.74, 0.44), smoothstep(150.0, 450.0, h));
    c = mix(c, vec3(0.68, 0.52, 0.36), smoothstep(450.0, 850.0, h));
    c = mix(c, vec3(0.95, 0.93, 0.88), smoothstep(850.0, 1300.0, h));
  }
  return gToLin(c);
}
`,Xt=`
{
  vec4 nt = texture2D(tNorm, vUv);
  float hC = nt.b * 128.0 - 96.0;
  float h = hC < -95.0 ? min(hC, vH) : (hC > 31.0 ? max(hC, vH) : hC);
  // Alpha is the photo's coverage (0 in the blank white/black blocks the service paints outside its footprint);
  // blank pixels are stored black, so rgb / alpha is the picture's own colour right up to the block edge.
  vec4 ph = texture2D(tPhoto, vUv, -0.35);
  float cov = smoothstep(0.30, 0.85, ph.a) * uHasPhoto;
  vec3 lin = ph.rgb / max(ph.a, 0.08);
  // Grade in display space: the aerial photo carries a blue haze veil and crushed shadows.
  vec3 s = pow(max(lin, 0.0), vec3(1.0 / 2.2));
  s = max(s - vec3(0.020, 0.034, 0.062), 0.0) * 1.11;
  float warm = max(s.r, s.g);
  if (s.b > warm) s.b = warm + (s.b - warm) * 0.45;
  float l = dot(s, vec3(0.30, 0.59, 0.11));
  float l2 = 0.035 + 0.965 * l;
  s = clamp(l2 + (s - l) * 1.16, 0.0, 1.0);
  vec3 land = gToLin(s);
  {
    // No photo here: colour by elevation so the page never shows a slab.
    float t = clamp(h / 1200.0, 0.0, 1.0);
    vec3 c = mix(vec3(0.33, 0.42, 0.22), vec3(0.20, 0.33, 0.15), smoothstep(0.0, 0.25, t));
    c = mix(c, vec3(0.42, 0.40, 0.30), smoothstep(0.55, 1.0, t));
    land = mix(gToLin(c), land, cov); l = mix(0.45, l, cov);
  }
  float wat = clamp(1.0 - nt.a * 2.0, 0.0, 1.0) * cov, built = clamp(nt.a * 2.0 - 1.0, 0.0, 1.0) * cov;
  // Seabed for the ocean pass to tint: wherever the merged model is under the sea, and at sea level where the photo
  // itself shows water (or shows nothing). Piers, the port and mangrove at 0 m keep their photo.
  float depth = max(0.0, -h);
  float shallow = 1.0 - smoothstep(0.0, 25.0, depth);
  // Sand against seagrass is read off the photo only where the water is shallow enough for it to show the real
  // bottom; deeper, plumes, glint and mosaic seams would print themselves on the seabed.
  float clearW = (1.0 - smoothstep(1.5, 7.0, depth)) * cov;
  float veg = mix(0.38, smoothstep(0.44, 0.10, l), clearW) * shallow;
  float grain = gHash(floor(vWxz / 40.0)) * 0.5 + gHash(floor(vWxz / 190.0)) * 0.5;
  vec3 bed = mix(vec3(0.60, 0.56, 0.45), vec3(0.50, 0.47, 0.39), grain);
  bed = mix(bed, vec3(0.13, 0.17, 0.11), veg * 0.75);
  bed = mix(bed, vec3(0.20, 0.20, 0.19), smoothstep(20.0, 70.0, depth));
  float low = 1.0 - smoothstep(0.25, 0.7, h);
  float under = max(smoothstep(-0.15, -0.45, h), low * max(smoothstep(0.3, 0.6, wat), 1.0 - cov));
  vec3 alb = mix(land, bed, under);
  if (uTintMode > 0.5) {
    float hh = (hC < -95.0 || hC > 31.0) ? vH : h;
    float g = dot(land, vec3(0.30, 0.59, 0.11));
    alb = gHypso(hh) * clamp(0.50 + 2.4 * mix(0.2, g, 1.0 - under), 0.35, 1.5);
  }
  vec2 ouv = vUv * uOvXf.xy + uOvXf.zw;
  vec4 ov = texture2D(tOverlay, ouv);
  alb = mix(alb, gToLin(pow(ov.rgb, vec3(1.0 / 2.2))), ov.a * uOvOpacity);
  gOvCov = ov.a * uOvOpacity;
  alb = mix(alb, alb * 0.35 + uTint * 0.65, uLod);
  diffuseColor.rgb = alb;
  // Town lights: built-up surface in the photo emits a sodium/LED mix, as points close up and as a glow from afar.
  gEmit = vec3(0.0);
  if (uNight > 0.01) {
    // Building density (buildings per zoom-14 tile, baked at start) decides where the lights are; the photo decides
    // their fine pattern. Dense metro glows, the Cordillera is dark with scattered points.
    float den = texture2D(tDensity, vUv * uDenXf.xy + uDenXf.zw).r;
    float wd = smoothstep(0.04, 0.60, den);
    float lit = (built * (0.55 + 0.45 * wd) + 0.04 * wd) * smoothstep(1.2, 3.5, h) * (1.0 - under);
    vec2 cell = vWxz / 30.0, ci = floor(cell), cf = fract(cell) - 0.5;
    float r1 = gHash(ci), r2 = gHash(ci + 71.7);
    vec2 off = (vec2(r2, fract(r2 * 7.31)) - 0.5) * 0.55;
    float p = mix(0.025, 0.46, wd);
    float pt = step(1.0 - p, r1) * smoothstep(0.42, 0.04, length(cf - off)) * 5.0;
    float fw = max(length(dFdx(vWxz)), length(dFdy(vWxz)));
    float far = smoothstep(7.0, 40.0, fw);
    vec3 col = mix(mix(vec3(1.0, 0.56, 0.22), vec3(0.92, 0.90, 0.80), step(0.68, r2)), vec3(1.0, 0.68, 0.38), far);
    gEmit = col * lit * mix(pt * (0.30 + 0.70 * wd), 0.12 + 1.7 * wd, far) * uNight * uLightGain * (1.0 - ov.a * uOvOpacity * 0.7);
  }
}
`,Zt=`
{
  vec2 nxz = texture2D(tNorm, vUv).rg * 2.0 - 1.0;
  // The photo already holds the real sun's shading, so the lit response is softened: horizontal part scaled down.
  nxz *= uRelief;
  vec3 nW = vec3(nxz.x, sqrt(max(0.05, 1.0 - dot(nxz, nxz))), nxz.y);
  normal = normalize(mat3(viewMatrix) * normalize(nW));
  nonPerturbedNormal = normal;
}
`,dt=[15079755,3978315,16769305,4416472,16089649,9510580,4649200,15741670,12383756,16432830];function jt(z,x,b,d,v,g){const y={tPhoto:{value:x},tNorm:{value:b},tOverlay:{value:d},uOvXf:{value:new Xe(1,1,0,0)},uHasPhoto:{value:v?1:0},uTint:{value:new Ft(dt[g%dt.length])},uDenXf:{value:new Xe(1,1,0,0)}},M=new xt({roughness:1,metalness:0,color:16777215});return M.defines={USE_UV:""},M.onBeforeCompile=C=>{Object.assign(C.uniforms,y,z),C.vertexShader=C.vertexShader.replace("#include <common>",`#include <common>
varying float vH; varying vec2 vWxz;`).replace("#include <worldpos_vertex>",`#include <worldpos_vertex>
        { vec4 wp = modelMatrix * vec4(transformed, 1.0); vH = wp.y + (wp.x * wp.x + wp.z * wp.z) / (2.0 * 6371008.8); vWxz = wp.xz; }`),C.fragmentShader=C.fragmentShader.replace("#include <common>",`#include <common>
`+Nt).replace("#include <map_fragment>",Xt).replace("#include <emissivemap_fragment>",`#include <emissivemap_fragment>
  totalEmissiveRadiance += gEmit;`).replace("#include <dithering_fragment>",`#include <dithering_fragment>
  gl_FragColor.a = 1.0 - gOvCov * uOvAbove;`).replace("#include <normal_fragment_maps>",Zt)},M.customProgramCacheKey=()=>"garita-tile-13",{material:M,uniforms:y}}const De=0,vt=1,$e=2,I=3,Ne=4,ae=129,qt=15,Yt=6e4,Kt=6,Vt="abyssal-plain",yt=-4e3;class pt{z;x;y;parent;children=null;state=De;box=new Rt;minH=-8500;maxH=1400;x0=0;x1=0;z0=0;z1=0;texel=0;mesh=null;mat=null;u=null;photo=null;ovKey="";fails=0;norm=null;hts=null;lastUsed=0;prio=0;failedAt=0;split=!1;noPhoto=!1;jobId=0;cost=0;worker=-1;ovGen=-1;dead=!1;degradedAt=0;retries=0;imgZ=0;constructor(x,b,d,v){this.z=x,this.x=b,this.y=d,this.parent=v;const g=ge(x,b,d),y=_e(g.west,g.north),M=_e(g.east,g.south);this.x0=y[0],this.z0=y[1],this.x1=M[0],this.z1=M[1],this.texel=(this.x1-this.x0)/256,v&&(this.minH=v.minH,this.maxH=v.maxH),this.setBox()}setBox(){const x=Math.min(Math.max(0,this.x0),this.x1),b=Math.min(Math.max(0,this.z0),this.z1),d=Math.max(Math.abs(this.x0),Math.abs(this.x1)),v=Math.max(Math.abs(this.z0),Math.abs(this.z1));this.box.min.set(this.x0,this.minH-Ze(d,v),this.z0),this.box.max.set(this.x1,this.maxH-Ze(x,b),this.z1)}}function Jt(z){const x=z+3,b=new Float32Array(x*x*2),d=new Uint16Array((x-1)*(x-1)*6);for(let v=0,g=0;v<x;v++)for(let y=0;y<x;y++,g+=2)b[g]=Math.min(z,Math.max(0,y-1))/z,b[g+1]=Math.min(z,Math.max(0,v-1))/z;for(let v=0,g=0;v<x-1;v++)for(let y=0;y<x-1;y++){const M=v*x+y,C=M+1,A=M+x,D=A+1;d[g++]=M,d[g++]=A,d[g++]=C,d[g++]=C,d[g++]=A,d[g++]=D}return{index:new we(d,1),uv:new we(b,2)}}function Qt(){const z=_e(ge(U,R,$).west,ge(U,R,$).north),x=_e(ge(U,ne,fe).east,ge(U,ne,fe).south),b=3e3,d=z[0]+b,v=z[1]+b,g=x[0]-b,y=x[1]-b,M=(d+g)/2,C=(v+y)/2,A=40,D=A*4,H=44,K=25e5,k=new Float32Array(D*H*3),T=new Uint32Array(D*(H-1)*6);for(let F=0;F<D;F++){const O=F/A|0,S=F%A/A,E=O===0?d+(g-d)*S:O===1?g:O===2?g-(g-d)*S:d,P=O===0?v:O===1?v+(y-v)*S:O===2?y:y-(y-v)*S,N=Math.atan2(P-C,E-M),J=Math.cos(N)*K,me=Math.sin(N)*K;for(let X=0;X<H;X++){const Z=Math.pow(X/(H-1),2.6),B=E+(J-E)*Z,Q=P+(me-P)*Z,se=X===0?-9500:yt,G=(X*D+F)*3;k[G]=B,k[G+1]=se-Ze(B,Q),k[G+2]=Q}}for(let F=0,O=0;F<H-1;F++)for(let S=0;S<D;S++){const E=F*D+S,P=F*D+(S+1)%D,N=E+D,J=P+D;T[O++]=E,T[O++]=P,T[O++]=N,T[O++]=P,T[O++]=J,T[O++]=N}const W=new gt;W.setAttribute("position",new we(k,3)),W.setIndex(new we(T,1)),W.computeVertexNormals();const V=new wt(W,new xt({color:2303530,roughness:1,metalness:0,side:Pt}));return V.name=Vt,V.frustumCulled=!1,V}function to(z){const{camera:x,renderer:b}=z,d=new St;d.name="terrain";const v=Qt();d.add(v),z.scene.add(d);const g=ut("wire"),y=ut("lod"),M=Math.min(16,b.capabilities.getMaxAnisotropy()),C=new ce(new Uint8Array([255,255,255,255]),1,1);C.needsUpdate=!0;const A=new ce(new Uint8Array([0,0,0,0]),1,1);A.needsUpdate=!0;const D=new ce(new Uint8Array([128,128,255,255]),1,1);D.needsUpdate=!0;const H={uOvOpacity:{value:0},uRelief:{value:.62},uLod:{value:y?1:0},uNight:{value:0},uTintMode:{value:0},uLightGain:{value:+(Lt.get("lights")??2.2)},uOvAbove:{value:0},tDensity:{value:null}},K=14-U,k=ne-R+1<<K,T=fe-$+1<<K,W=new ce(new Uint8Array(k*T).fill(70),k,T,Et);W.minFilter=W.magFilter=Le,W.needsUpdate=!0,H.tDensity.value=W,fetch(ue("tiles/bld/index.json")).then(e=>e.ok&&!(e.headers.get("content-type")||"").startsWith("text/html")?e.json():null).then(e=>{if(!e||!Array.isArray(e.tiles)||(e.zoom??14)!==14)return;const t=new Float32Array(k*T);for(const[n,i,f]of e.tiles){const r=n-(R<<K),l=i-($<<K);r>=0&&l>=0&&r<k&&l<T&&(t[l*k+r]=f)}const o=W.image.data;let a=t;for(let n=0;n<2;n++){const i=new Float32Array(k*T);for(let f=0;f<T;f++)for(let r=0;r<k;r++){let l=0,p=0;for(let h=-1;h<=1;h++)for(let s=-1;s<=1;s++){const m=r+s,c=f+h;if(m<0||c<0||m>=k||c>=T)continue;const u=s||h?s&&h?.5:1:2;l+=a[c*k+m]*u,p+=u}i[f*k+r]=l/p}a=i}for(let n=0;n<k*T;n++)o[n]=Math.round(255*Math.min(1,a[n]/5e3));W.needsUpdate=!0}).catch(()=>{});const V=new Map,F=e=>{let t=V.get(e);return t||V.set(e,t=Jt(e)),t};let O=null,S=!1;const E=(e,t)=>e*65536+t;fetch(ue("tiles/index.json")).then(e=>e.ok&&!(e.headers.get("content-type")||"").startsWith("text/html")?e.json():null).then(e=>{if(e&&e.dem&&e.img){const t=o=>{const a=new Map;for(const n in o)a.set(+n,new Set(o[n].map(([i,f])=>E(i,f))));return a};O={dem:t(e.dem),img:t(e.img)}}}).catch(()=>{}).finally(()=>{S=!0});let P=null,N=!1,J=99,me=0;fetch(ue("tiles/bathy/index.json")).then(e=>e.ok&&!(e.headers.get("content-type")||"").startsWith("text/html")?e.json():null).then(e=>{if(e&&e.tiles){const t=new Map;for(const o in e.tiles)t.set(+o,new Set(e.tiles[o].map(([a,n])=>E(a,n)))),J=Math.min(J,+o),me=Math.max(me,+o);t.size&&(P=t)}}).catch(()=>{}).finally(()=>{N=!0});const X=(e,t,o)=>ue(`tiles/bathy/${e}/${t}/${o}.png`),Z=(e,t,o,a)=>O?!!O[e].get(t)?.has(E(o,a)):t<=10,B={dem:0,img:0},Q={dem:0,img:0},se=e=>Math.min(Yt,2e3*2**Math.min(e,5)),G=new Map,ye=(e,t)=>{const o=G.get(e);return o===void 0||t>o},be=(e,t,o)=>ue(`tiles/dem/${e}/${t}/${o}.png`),je=(e,t,o)=>ue(`tiles/img/${e}/${t}/${o}.jpg`);function bt(e,t){const{z:o,x:a,y:n}=e,i=[];Z("dem",o,a,n)?ye(be(o,a,n),t)&&i.push({url:be(o,a,n),z:o,x:a,y:n}):o>10&&o<=xe.demMaxZoom&&t>B.dem&&ye(xe.dem(o,a,n),t)&&i.push({url:xe.dem(o,a,n),z:o,x:a,y:n});for(let s=o-1;s>=U;s--){const m=o-s,c=a>>m,u=n>>m;if(Z("dem",s,c,u)){i.push({url:be(s,c,u),z:s,x:c,y:u});break}}const f=(s,m,c)=>{const u=Z("img",s,m,c)?je(s,m,c):s>10&&s<=xe.imgMaxZoom&&t>B.img?xe.img(s,m,c):null;return u&&ye(u,t)?u:null},r=[];let l=null;if(!e.noPhoto){const s=[f(o+1,2*a,2*n),f(o+1,2*a+1,2*n),f(o+1,2*a,2*n+1),f(o+1,2*a+1,2*n+1)];s.every(Boolean)&&r.push(s);const m=f(o,a,n);m&&r.push([m]);for(let c=o-1;c>=U&&!l;c--){const u=o-c,w=a>>u,_=n>>u;Z("img",c,w,_)&&(l={url:je(c,w,_),z:c,x:w,y:_})}if(!r.length&&!(i.length&&i[0].z===o&&l)&&o>U)return null}if(!i.length&&o>U)return null;let p=null;if(P)for(let s=Math.min(o,me);s>=J&&!p;s--){const m=o-s,c=a>>m,u=n>>m;P.get(s)?.has(E(c,u))&&ye(X(s,c,u),t)&&(p={url:X(s,c,u),z:s,x:c,y:u})}const h=[];if(o>=11)for(let s=10;s>=U;s--){const m=o-s,c=a>>m,u=n>>m;if(Z("dem",s,c,u)){h.push({url:be(s,c,u),z:s,x:c,y:u});break}}return{type:"tile",id:0,z:o,x:a,y:n,grid:o>=14?128:64,dem:i,img:r,crop:l,cudem:p,bathy:h,root:o===U}}const Mt=Math.max(2,Math.min(4,(navigator.hardwareConcurrency||4)-2)),ee=[],he=[],de=new Map;let qe=1,Me=0,ve=0;for(let e=0;e<Mt;e++){const t=new Worker(new URL(""+new URL("tileWorker-DGsIkrly.js",import.meta.url).href,import.meta.url),{type:"module"});t.onmessage=o=>Ot(e,o.data),ee.push(t),he.push(0)}function Ot(e,t){if(t.type)return;const o=de.get(t.id),a=performance.now();for(const n of t.failed){const i=n.slice(n.indexOf("|")+1);n.startsWith("http|")?(G.size>6e3&&G.clear(),G.set(i,a+18e4)):i.includes("amazonaws")?B.dem=a+se(Q.dem++):i.includes("nationalmap")?B.img=a+se(Q.img++):G.set(i,a+8e3)}for(const n of t.okUrls)n.includes("amazonaws")?(B.dem=0,Q.dem=0):n.includes("nationalmap")&&(B.img=0,Q.img=0);if(o){if(de.delete(t.id),he[e]--,Me-=o.cost,o.jobId=0,t.aborted||o.dead){o.state===$e&&(o.state=De);return}if(!t.ok){o.state===I?o.degradedAt=a:(o.state=Ne,o.failedAt=a,o.fails++);return}Oe.push({t:o,r:t})}}const Oe=[];function zt(e){for(let t=0;t<e&&Oe.length;t++){const{t:o,r:a}=Oe.shift();o.dead||(o.state===I&&(Ye(o),ve--),o.degradedAt=a.degraded?performance.now():0,At(o,a))}}function At(e,t){const o=e.z>=14?128:64,a=F(o),n=new gt;if(n.setAttribute("position",new we(t.pos,3)),n.setAttribute("uv",a.uv),n.setIndex(a.index),e.norm=new ce(t.norm,256,256,ht),e.norm.generateMipmaps=!0,e.norm.minFilter=Ue,e.norm.magFilter=Le,e.norm.anisotropy=Math.min(4,M),e.norm.needsUpdate=!0,t.photo){const l=new ce(t.photo,t.photoW,t.photoW,ht);l.colorSpace=Be,l.flipY=!1,l.premultiplyAlpha=!1,l.onUpdate=()=>{l.image.data=null},l.generateMipmaps=!0,l.minFilter=Ue,l.magFilter=Le,l.anisotropy=M,l.needsUpdate=!0,e.photo=l}const{material:i,uniforms:f}=jt(H,e.photo??C,e.norm,A,!!e.photo,e.z);i.wireframe=g;{const l=2**(e.z-U),p=1/(l*(ne-R+1)),h=1/(l*(fe-$+1));f.uDenXf.value.set(p,h,(e.x-R*l)*p,(e.y-$*l)*h)}e.mat=i,e.u=f;const r=new wt(n,i);r.position.set(t.cx,t.cy,t.cz),r.frustumCulled=!1,r.visible=!1,r.matrixAutoUpdate=!1,r.updateMatrix(),r.receiveShadow=e.z>=13,r.name=`tile ${e.z}/${e.x}/${e.y}`,d.add(r),e.mesh=r,e.hts=t.hts,e.minH=t.minH,e.maxH=t.maxH,e.imgZ=t.imgZ||0,e.setBox(),e.state=I,ve++}function Ye(e){e.mesh&&(d.remove(e.mesh),e.mesh.geometry.dispose(),e.mesh=null),e.mat?.dispose(),e.mat=null,e.u=null,e.photo&&(e.photo.dispose(),e.photo=null),st(e),e.norm?.dispose(),e.norm=null,e.hts=null,e.ovGen=-1}function Ke(e){e.jobId&&ee[e.worker].postMessage({type:"abort",id:e.jobId}),Ye(e),e.state===I&&ve--,e.state=De,e.dead=!0}const te=[];for(let e=$;e<=fe;e++)for(let t=R;t<=ne;t++)te.push(new pt(U,t,e,null));const kt=ne-R+1,Ve=new Gt,Je=new Bt,Qe=new Ee,ie=[],j=[];let oe=0,et=1,tt=2.3,le=0,ze=0;function ot(e,t){e.prio=t,e.lastUsed=oe,(e.state===De||e.state===Ne&&le-e.failedAt>se(e.fails))&&(e.state=vt),e.state===vt&&j.push(e)}function at(e){if(e.lastUsed=oe,e.state!==I){ot(e,1e9);return}if(!Ve.intersectsBox(e.box))return;const t=Math.max(1,e.box.distanceToPoint(Qe)),o=e.texel*et/t;e.degradedAt&&le-e.degradedAt>se(e.retries+1)&&!e.jobId&&e.retries<8&&(e.retries++,e.degradedAt=le,e.prio=o,j.push(e));const a=e.maxH<-40?11:qt,n=e.z<=10&&e.photo&&e.imgZ<e.z?.3:1;if(e.z<a&&o>tt*n*(e.split?.8:1)){if(!e.children){e.children=[];for(let r=0;r<4;r++){const l=new pt(e.z+1,e.x*2+(r&1),e.y*2+(r>>1),e);l.noPhoto=e.maxH<-40,e.children.push(l)}}let i=!0;const f=e.children;for(let r=0;r<4;r++){const l=f[r];l.state!==I?(i=!1,ot(l,o)):l.lastUsed=oe}if(i){e.split=!0;for(let r=0;r<4;r++)at(f[r]);return}}e.split=!1,e.mesh.visible=!0,ie.push(e),e.z>ze&&(ze=e.z),q&&e.ovGen!==pe&&_t(e)}const Tt=(e,t)=>t.prio-e.prio;function Ut(){if(j.length){j.sort(Tt);for(let e=0;e<j.length;e++){const t=j[e],o=bt(t,le);if(!o){t.state!==I&&(t.state=Ne,t.failedAt=le,t.fails=Math.max(t.fails,5));continue}const a=Math.max(1,o.img.length?o.img[0].length:0);if(Me>0&&Me+a>Kt)break;let n=0;for(let i=1;i<ee.length;i++)he[i]<he[n]&&(n=i);o.id=qe++,t.jobId=o.id,t.cost=a,t.worker=n,t.state!==I&&(t.state=$e),de.set(o.id,t),he[n]++,Me+=a,ee[n].postMessage(o)}}}const Ae=[],Ce=e=>Math.max(e.children[0].lastUsed,e.children[1].lastUsed,e.children[2].lastUsed,e.children[3].lastUsed);function nt(e){if(!e.children)return;let t=!0;for(const o of e.children)o.children&&(t=!1,nt(o));t&&Ce(e)<oe-90&&Ae.push(e)}function Dt(){for(const t of de.values())t.lastUsed<oe-45&&t.z>U&&ee[t.worker].postMessage({type:"abort",id:t.jobId});const e={low:220,medium:350,high:520}[Pe.value];Ae.length=0;for(const t of te)nt(t);ve>e&&Ae.sort((t,o)=>Ce(t)-Ce(o));for(const t of Ae)if(!(t.children.some(a=>a.state===I||a.state===$e)&&ve<=e)){for(const a of t.children)Ke(a);t.children=null,t.split=!1}}let q=null,pe=0;const Y=new Map;function He(e,t){t.tex&&(t.tex.image?.close?.(),t.tex.dispose(),t.tex=null),t.gen=-1,t.waiters.length=0,Y.get(e)===t&&Y.delete(e)}function st(e){if(!e.ovKey)return;const t=Y.get(e.ovKey);if(t){const o=t.waiters.indexOf(e);o>=0&&t.waiters.splice(o,1),--t.refs<=0&&He(e.ovKey,t)}e.ovKey=""}function _t(e){st(e),e.ovGen=pe;const t=q,o=e.u;if(o.tOverlay.value=A,e.z<t.minZoom)return;const a=Math.max(0,e.z-t.maxZoom),n=e.z-a,i=e.x>>a,f=e.y>>a,r=1/2**a;o.uOvXf.value.set(r,r,(e.x-i*2**a)*r,(e.y-f*2**a)*r);const l=t.draw?"":t.url(n,i,f);if(!t.draw&&!l)return;const p=`${n}/${i}/${f}`,h=pe;let s=Y.get(p);if(!s){Y.set(p,s={tex:null,done:!1,waiters:[],refs:0,gen:h});const m=s;(t.draw?Promise.resolve().then(()=>t.draw(n,i,f)):fetch(l,{mode:"cors"}).then(u=>u.ok?u.blob():Promise.reject(u.status)).then(u=>createImageBitmap(u,{premultiplyAlpha:"none"}))).then(u=>{if(!u)return;if(m.gen!==h||h!==pe){u.close?.();return}const w=new $t(u);w.colorSpace=Be,w.flipY=!1,w.premultiplyAlpha=!1,w.generateMipmaps=!0,w.minFilter=Ue,w.anisotropy=Math.min(4,M),w.needsUpdate=!0,m.tex=w;for(const _ of m.waiters)_.u&&_.ovGen===h&&(_.u.tOverlay.value=w)}).catch(()=>{}).finally(()=>{m.done=!0,m.waiters.length=0})}s.refs++,e.ovKey=p,s.tex?o.tOverlay.value=s.tex:s.done||s.waiters.push(e)}const re={tOv:{value:A},uOvBox:{value:new Xe(0,0,1,1)},uOvOn:{value:0}},Ct=v.material;Ct.onBeforeCompile=e=>{Object.assign(e.uniforms,re,{uOvOpacity:H.uOvOpacity,uOvAbove:H.uOvAbove}),e.vertexShader=e.vertexShader.replace("#include <common>",`#include <common>
varying vec2 vWxz;`).replace("#include <worldpos_vertex>",`#include <worldpos_vertex>
  vWxz = (modelMatrix * vec4(transformed, 1.0)).xz;`),e.fragmentShader=e.fragmentShader.replace("#include <common>",`#include <common>
uniform sampler2D tOv; uniform vec4 uOvBox; uniform float uOvOn; uniform float uOvOpacity; uniform float uOvAbove; varying vec2 vWxz; float gOvCov;`).replace("#include <map_fragment>",`#include <map_fragment>
        gOvCov = 0.0;
        if (uOvOn > 0.5) {
          float lon = ${Te.lon.toFixed(4)} + vWxz.x / ${ft.toFixed(2)}, lat = radians(${Te.lat.toFixed(4)} - vWxz.y / ${mt.toFixed(2)});
          vec2 ouv = (vec2((lon + 180.0) / 360.0, 0.5 - log(tan(0.78539816 + lat * 0.5)) / 6.28318531) - uOvBox.xy) * uOvBox.zw;
          if (ouv.x > 0.0 && ouv.x < 1.0 && ouv.y > 0.0 && ouv.y < 1.0) {
            vec4 ov = texture2D(tOv, ouv);
            gOvCov = ov.a * uOvOpacity;
            diffuseColor.rgb = mix(diffuseColor.rgb, ov.rgb, gOvCov);
          }
        }`).replace("#include <dithering_fragment>",`#include <dithering_fragment>
  gl_FragColor.a = 1.0 - gOvCov * uOvAbove;`)};let it=0,ke=null;function Ht(e){const t=++it;if(re.uOvOn.value=0,re.tOv.value=A,ke?.dispose(),ke=null,!e||!e.aboveWater||typeof document>"u")return;const o=Math.max(e.minZoom,Math.min(e.maxZoom,6)),a=2**o,n=Math.floor(Ge(-76,o)),i=Math.floor(Ge(-58,o)),f=Math.floor(Ie(26,o)),r=Math.floor(Ie(11,o)),l=i-n+1,p=r-f+1,h=256;if(l*p>40)return;const s=document.createElement("canvas");s.width=l*h,s.height=p*h;const m=s.getContext("2d"),c=new It(s);c.colorSpace=Be,c.flipY=!1,c.generateMipmaps=!0,c.minFilter=Ue,ke=c,re.tOv.value=c,re.uOvBox.value.set(n/a,f/a,a/l,a/p),re.uOvOn.value=1;for(let u=f;u<=r;u++)for(let w=n;w<=i;w++){const _=e.draw?"":e.url(o,w,u);if(!e.draw&&!_)continue;(e.draw?Promise.resolve().then(()=>e.draw(o,w,u)):fetch(_,{mode:"cors"}).then(L=>L.ok?L.blob():Promise.reject(L.status)).then(L=>createImageBitmap(L))).then(L=>{L&&(t===it&&(m.drawImage(L,(w-n)*h,(u-f)*h,h,h),c.needsUpdate=!0),e.draw||L.close?.())}).catch(()=>{})}}function We(e,t){if(t(e),e.children)for(const o of e.children)We(o,t)}function lt(e,t){const o=Te.lon+e/ft,a=Te.lat-t/mt;let n=Ge(o,U),i=Ie(a,U);const f=Math.floor(n),r=Math.floor(i);if(f<R||f>ne||r<$||r>fe)return null;let l=te[(r-$)*kt+(f-R)];if(!l.hts)return 0;for(n-=f,i-=r;l.children;){const Se=n>=.5?1:0,L=i>=.5?1:0,ct=l.children[L*2+Se];if(!ct.hts)break;n=n*2-Se,i=i*2-L,l=ct}const p=l.hts,h=n*(ae-1),s=i*(ae-1),m=Math.min(ae-2,h|0),c=Math.min(ae-2,s|0),u=h-m,w=s-c,_=c*ae+m;return((p[_]*(1-u)+p[_+1]*u)*(1-w)+(p[_+ae]*(1-u)+p[_+ae+1]*u)*w)*.5}const rt=(e,t)=>(lt(e,t)??yt)-(e*e+t*t)/(2*Re);function Wt(e,t,o=4e6){let a=0,n=0;for(let i=0;i<300&&a<=o;i++){const f=e.x+t.x*a,r=e.y+t.y*a,l=e.z+t.z*a,p=r-rt(f,l);if(p<=0){if(i===0)return new Ee(f,r,l);let h=n,s=a;for(let m=0;m<14;m++){const c=(h+s)/2,u=e.x+t.x*c,w=e.z+t.z*c;e.y+t.y*c-rt(u,w)>0?h=c:s=c}return new Ee(e.x+t.x*s,e.y+t.y*s,e.z+t.z*s)}if(p>12e3&&t.y*Re+(f*t.x+l*t.z)>0&&i>4&&r+(f*f+l*l)/(2*Re)>1500)return null;n=a,a+=Math.max(8,a*.004,p*.45)}return null}const Fe={group:d,update(e){oe++,le=performance.now(),Qe.setFromMatrixPosition(x.matrixWorld),Je.multiplyMatrices(x.projectionMatrix,x.matrixWorldInverse),Ve.setFromProjectionMatrix(Je),et=b.domElement.height/(2*Math.tan(x.fov*Math.PI/360)),tt=Pe.value==="low"?3.4:Pe.value==="high"?1.7:2.3;for(let t=0;t<ie.length;t++)ie[t].mesh&&(ie[t].mesh.visible=!1);if(ie.length=0,j.length=0,ze=0,H.uNight.value=z.night,zt(e.dt>.03?2:4),S&&N){for(let t=0;t<te.length;t++)at(te[t]);Ut()}oe%20===0&&Dt()},heightAt:lt,raycast:Wt,setTint(e){H.uTintMode.value=e==="elevation"?1:0},setOverlay(e,t){if(H.uOvOpacity.value=e?t:0,H.uOvAbove.value=e?.aboveWater?1:0,!(e===q||e&&q&&e.id===q.id&&e.url===q.url&&e.draw===q.draw)){q=e,pe++;for(const[o,a]of[...Y])He(o,a);Y.clear();for(const o of te)We(o,a=>{a.ovKey="",a.u&&(a.u.tOverlay.value=A)});Ht(e)}},stats:()=>({tiles:ie.length,pending:j.length+de.size+Oe.length,maxZoom:ze}),dispose(){for(const e of ee)e.terminate();for(const e of te)We(e,Ke);for(const[e,t]of[...Y])He(e,t);for(const e of V.values());v.geometry.dispose(),v.material.dispose(),C.dispose(),A.dispose(),D.dispose(),W.dispose(),ke?.dispose(),z.scene.remove(d)}};return Fe.decodeTest=e=>new Promise(t=>{const o=qe++,a=ee[0],n=i=>{i.data.type==="decodeTest"&&i.data.id===o&&(a.removeEventListener("message",n),t(i.data))};a.addEventListener("message",n),a.postMessage({type:"decodeTest",id:o,url:e})}),Fe.abyssal=v,Fe}export{yt as ABYSSAL_DEPTH,Vt as ABYSSAL_NAME,to as createTerrain};
