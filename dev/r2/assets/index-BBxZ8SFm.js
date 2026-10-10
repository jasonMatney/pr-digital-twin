import{M as _e,W as Ae,G as Te,d as ge,Q as Re,T as H,ae as Ee,Y as Ne,U as qe,P as Oe,l as Pe,r as xe,n as pe,g as Ue,af as je,o as Ge,s as Ke,ag as We,ah as be,q as De,ab as Ie,a6 as $e,a5 as Ve}from"./r2-D6SpO1sY.js";const Xe=`
  attribute vec4 aFac; attribute vec3 aBld;
  varying vec4 vFac; flat varying vec3 vBld; varying vec2 vLxz;
`,Ye=`
  varying vec4 vFac; flat varying vec3 vBld; varying vec2 vLxz;
  uniform float uBNight, uBLit, uBSea, uBNfhl;
  vec3 gBEmis = vec3(0.0); float gBRough = 0.92;
  const vec3 B_HOUSE[12] = vec3[12](vec3(.93,.9,.8), vec3(.96,.86,.6), vec3(.78,.9,.8), vec3(.76,.86,.94), vec3(.96,.8,.7), vec3(.94,.78,.82),
    vec3(.96,.95,.92), vec3(.86,.84,.8), vec3(.98,.9,.5), vec3(.68,.86,.74), vec3(.86,.74,.9), vec3(.98,.72,.52));
  const vec3 B_APT[7] = vec3[7](vec3(.95,.94,.9), vec3(.93,.89,.8), vec3(.88,.86,.82), vec3(.96,.9,.78), vec3(.86,.9,.94), vec3(.95,.85,.76), vec3(.8,.88,.84));
  const vec3 B_COM[7] = vec3[7](vec3(.9,.89,.86), vec3(.74,.74,.73), vec3(.94,.9,.8), vec3(.56,.58,.6), vec3(.84,.78,.68), vec3(.92,.92,.91), vec3(.82,.88,.9));
  const vec3 B_PUB[4] = vec3[4](vec3(.95,.93,.87), vec3(.93,.85,.66), vec3(.86,.86,.84), vec3(.85,.74,.6));
  float bHash(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float bNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(bHash(i), bHash(i + vec2(1, 0)), f.x), mix(bHash(i + vec2(0, 1)), bHash(i + vec2(1, 1)), f.x), f.y); }
  float bBox(float x, float a, float b, float w) { return clamp(smoothstep(a - w, a + w, x) - smoothstep(b - w, b + w, x), 0.0, 1.0); }
  vec3 bWall(float kind, float seed, float h) {
    vec3 c;
    if (kind < 0.5) c = B_HOUSE[int(seed * 11.999)];
    else if (kind < 1.5) c = B_APT[int(seed * 6.999)];
    else if (kind < 2.5) c = B_COM[int(seed * 6.999)];
    else if (kind < 3.5) c = mix(vec3(.72, .73, .74), vec3(.87, .87, .85), h);
    else c = B_PUB[int(seed * 3.999)];
    return pow(c, vec3(2.2)) * (0.74 + 0.18 * h);
  }
`,Ze=`
  {
    float code = floor(vBld.z + 0.5);
    float flood = floor(code / 32.0); code -= flood * 32.0;
    float part = floor(code / 8.0), kind = code - part * 8.0;
    float H = vBld.x * 0.1, ground = vBld.y * 0.1;
    float u = vFac.x, v = vFac.y, seed = vFac.z, bayW = vFac.w;
    float dist = length(vViewPosition);
    float h1 = bHash(vec2(seed * 917.0, 3.1)), h2 = bHash(vec2(seed * 573.0, 9.7)), h3 = bHash(vec2(seed * 331.0, 5.3));
    vec3 wallC = bWall(kind, seed, h1);

    // flat concrete roof: off-white to grey, weathered, some with dark stains; a few small houses in metal
    float n1 = bNoise(vLxz * 0.13 + seed * 37.0);
    float nearK = 1.0 - smoothstep(120.0, 420.0, dist);
    // what Puerto Rican roofs look like from the air: white or silver sealant, bare concrete, dull red-brown
    // sealant on houses, a few old and dark
    vec3 roofC;
    if (h2 < 0.34) roofC = vec3(mix(0.5, 0.68, h3)) * vec3(1.0, 0.99, 0.95);
    else if (h2 < 0.78) roofC = vec3(mix(0.27, 0.44, h3)) * vec3(1.0, 0.97, 0.92);
    else if (h2 < 0.9) roofC = kind < 0.5 ? mix(vec3(0.3, 0.15, 0.11), vec3(0.37, 0.24, 0.19), h3) : vec3(0.4, 0.39, 0.37);
    else roofC = vec3(mix(0.16, 0.25, h3)) * vec3(1.0, 0.98, 0.95);
    roofC *= 0.76 + 0.42 * n1;
    roofC *= 1.0 - 0.14 * nearK * bNoise(vec2(vLxz.x * 0.9 + seed * 5.0, vLxz.y * 0.07 + seed * 3.0));   // rain streaks
    roofC *= 1.0 - 0.34 * smoothstep(0.5, 0.82, bNoise(vLxz * 0.045 + seed * 91.0)) * step(0.35, h1);
    roofC *= mix(1.0, 0.9 + 0.2 * bNoise(vLxz * 1.1 + seed * 11.0), nearK);
    if (kind < 0.5 && H < 5.0) {
      float corr = mix(1.0, 0.86 + 0.28 * abs(fract((vLxz.x * (0.5 + h2) + vLxz.y * (1.5 - h2)) * 1.1) - 0.5), nearK);
      if (h3 < 0.06) roofC = vec3(0.23, 0.085, 0.06) * (0.8 + 0.4 * n1) * corr;
      else if (h3 < 0.15) roofC = vec3(0.36, 0.38, 0.4) * (0.8 + 0.35 * n1) * corr;
    }
    {  // water tanks and roof plant: dark dots about 1.3 m across, gone before they can shimmer
      vec2 tg = vLxz / 6.5 + seed * 7.0, tc = floor(tg);
      float th = bHash(tc + seed * 13.0), tw = max(fwidth(tg.x), fwidth(tg.y));
      vec2 tp = fract(tg) - 0.5 - (vec2(bHash(tc + 3.7), bHash(tc + 9.1)) - 0.5) * 0.5;
      float tank = (1.0 - smoothstep(0.1 - tw, 0.1 + tw, length(tp))) * step(th, 0.2) * (1.0 - smoothstep(0.03, 0.1, tw));
      roofC = mix(roofC, th < 0.1 ? vec3(0.03, 0.035, 0.045) : th < 0.16 ? vec3(0.05, 0.09, 0.18) : vec3(0.6), tank);
    }
    roofC *= mix(1.0, 0.5, uBNight);                 // roofs go dark at night
    wallC *= mix(1.0, 0.72, uBNight);
    bool roofLike = part > 0.5 || !gl_FrontFacing;
    vec3 c;
    if (roofLike) {
      c = part > 0.5 ? roofC : roofC * 0.7;          // the inner face of the parapet
    } else {
      c = wallC;
      float floors = max(1.0, floor(H / 3.1 + 0.4)), floorH = H / floors;
      if (bayW > 0.0 && H > 2.4 && v > 0.0 && v < H) {
        vec2 g = vec2(u, v / floorH), cell = floor(g), f = fract(g);
        vec2 w = max(fwidth(g), vec2(1e-4));
        vec4 r = kind < 0.5 ? vec4(0.27, 0.73, 0.30, 0.71) : kind < 2.5 ? vec4(0.13, 0.87, 0.27, 0.80) : vec4(0.2, 0.8, 0.46, 0.8);
        float share = kind < 0.5 ? 0.76 : kind > 2.5 && kind < 3.5 ? 0.4 : 0.94;      // some bays are plain wall
        float has = step(bHash(cell * 1.31 + seed * 131.0), share);
        float win = bBox(f.x, r.x, r.y, w.x) * bBox(f.y, r.z, r.w, w.y) * has;
        vec2 fw = vec2(0.09 / bayW, 0.09 / floorH);
        float outer = bBox(f.x, r.x - fw.x, r.y + fw.x, w.x) * bBox(f.y, r.z - fw.y, r.w + fw.y, w.y) * has;
        // recessed glazing: darker under the head of the opening, a mullion down the middle of wide panes
        vec3 glass = vec3(0.035, 0.05, 0.065) * (0.6 + 0.8 * bHash(cell + seed * 17.0));
        glass *= mix(1.0, 0.45, smoothstep(r.w - 0.14, r.w, f.y));
        float mull = 1.0 - bBox(f.x, 0.5 - 0.02, 0.5 + 0.02, w.x);
        vec3 frameC = mix(wallC, vec3(0.78), 0.65);
        vec3 det = mix(c, frameC, clamp(outer - win, 0.0, 1.0));
        det = mix(det, mix(frameC, glass, mull), win);
        float cover = (r.y - r.x) * (r.w - r.z) * share;
        vec3 avg = mix(c, vec3(0.05, 0.065, 0.08), cover);
        float blur = smoothstep(0.22, 0.6, max(w.x, w.y));
        c = mix(det, avg, blur);
        gBRough = mix(0.92, mix(0.22, 0.92, blur), win);
        // night: rooms lit one by one; one building is asleep, the next is busy
        float busy = clamp(uBLit * (0.25 + 1.5 * h2), 0.0, 0.95);
        float lit = step(bHash(cell * 1.7 + seed * 53.0), busy);
        vec3 warm = mix(vec3(1.0, 0.6, 0.27), vec3(0.85, 0.88, 0.8), step(0.86, bHash(cell + seed * 3.0)));
        gBEmis = warm * uBNight * 1.15 * mix(win * lit * mull, cover * busy * 0.8, blur);
      }
      c *= mix(0.58, 1.0, smoothstep(0.0, 0.6, v)) * (0.9 + 0.1 * clamp(v / H, 0.0, 1.0));   // grounding
    }
    // hazard views. Bathtub screen: ground elevation against the scenario water level, nothing more.
    float upper = roofLike ? 1.0 : smoothstep(0.3, 0.7, v / max(H, 1.0));
    if (uBSea > 0.05 && ground <= uBSea) { c = mix(c, vec3(1.0, 0.145, 0.043), 0.56 * upper); gBEmis *= 1.0 - upper; }
    if (uBNfhl > 0.5 && roofLike && flood > 0.5)
      c = mix(c, flood < 1.5 ? vec3(0.915, 0.459, 0.0072) : flood < 2.5 ? vec3(0.038, 0.359, 0.807) : vec3(0.201, 0.119, 1.0), 0.66);
    diffuseColor.rgb = c;
  }
`;function Qe(){const M={uBNight:{value:0},uBLit:{value:.4},uBSea:{value:0},uBNfhl:{value:0}},y=new _e({color:16777215,roughness:.92,metalness:0,side:Ae});return y.onBeforeCompile=l=>{Object.assign(l.uniforms,M),l.vertexShader=l.vertexShader.replace("#include <common>",`#include <common>
`+Xe).replace("#include <begin_vertex>",`#include <begin_vertex>
 vFac = aFac; vBld = aBld; vLxz = position.xz;`),l.fragmentShader=l.fragmentShader.replace("#include <common>",`#include <common>
`+Ye).replace("#include <color_fragment>",Ze).replace("#include <roughnessmap_fragment>",`#include <roughnessmap_fragment>
 roughnessFactor = gBRough;`).replace("#include <emissivemap_fragment>",`#include <emissivemap_fragment>
 totalEmissiveRadiance += gBEmis;`)},y.customProgramCacheKey=()=>"garita-buildings-4",{material:y,uniforms:M}}const Y=14,Je=14e3,et=.45,tt=4,ot=3,it=async M=>{const{world:y}=M,l=new Te;l.name="buildings",y.scene.add(l);const{material:Z,uniforms:C}=Qe(),Q=new Set;try{const t=await fetch(ge("tiles/bld/index.json")).then(e=>e.ok?e.json():null);for(const e of t?.tiles??[])Q.add(e[0]+"/"+e[1])}catch(t){console.warn("[garita/buildings] no building index",t)}const E=new Worker(new URL(""+new URL("worker-Ce5d_ZBp.js",import.meta.url).href,import.meta.url),{type:"module"}),g=new Map,N=new Map,B=[],S=[];let we=1,z=0,q=0,F=!1,J=-1,O=0,P=0,U=0,j=0;const G=t=>{t.mesh&&(l.remove(t.mesh),t.mesh.geometry.dispose(),P-=t.count,U-=t.tris,j--),t.mesh=null,t.pick=null,g.delete(t.key),N.delete(t.id)};E.onmessage=t=>{const e=t.data,o=N.get(e.id);if(z--,!o||F)return;if("error"in e){o.state="failed",console.warn("[garita/buildings] meshing failed",o.key,e.error);return}if(o.state="ready",o.count=e.count,o.tris=e.triangles,o.yRef=e.yRef,o.pick=e,!e.count)return;const a=new Re;a.setAttribute("position",new H(e.position,3)),a.setAttribute("normal",new H(e.normal,3,!0)),a.setAttribute("aFac",new H(e.fac,4)),a.setAttribute("aBld",new H(e.bld,3)),a.setIndex(new H(e.index,1)),a.boundingSphere=new Ee(new Ne(e.sphere[0],e.sphere[1],e.sphere[2]),e.sphere[3]);const n=new qe(a,Z);n.matrixAutoUpdate=!1,n.position.set(e.cx,e.yRef,e.cz),n.scale.set(1,.02,1),n.updateMatrix(),o.mesh=n,o.born=O,o.fading=!0,l.add(n),P+=o.count,U+=o.tris,j++};const ye=t=>{t.state="loading",z++,fetch(ge(`tiles/bld/${Y}/${t.x}/${t.y}.bin`)).then(e=>{if(!e.ok)throw new Error("HTTP "+e.status);return e.arrayBuffer()}).then(e=>{if(F||g.get(t.key)!==t){z--;return}const o={id:t.id,x:t.x,y:t.y,buf:e};E.postMessage(o,[e])}).catch(e=>{z--,t.state="failed",F||console.warn("[garita/buildings] tile failed",t.key,String(e))})},Be=(t,e)=>t.d-e.d,ze=(t,e)=>t.used-e.used||e.d-t.d,ke=t=>{const e=De.value==="low",o=e?20:44;let a=be.clamp(t*1.15+1200,2600,8600);e&&(a*=.5);const n=y.controls.target,[c,r]=Ie(n.x,n.z),d=Ve(c,Y),v=$e(r,Y),h=a/2320;q++,B.length=0;for(let s=Math.floor(v-h);s<=Math.floor(v+h);s++)for(let u=Math.floor(d-h);u<=Math.floor(d+h);u++){const x=u+"/"+s;if(!Q.has(x))continue;const p=Math.max(u-d,0,d-u-1),b=Math.max(s-v,0,v-s-1);if(p*p+b*b>h*h)continue;let m=g.get(x);m||(m={key:x,x:u,y:s,id:we++,state:"queued",used:0,d:0,born:0,fading:!1,mesh:null,pick:null,count:0,tris:0,yRef:0},g.set(x,m),N.set(m.id,m)),m.d=Math.hypot(u+.5-d,s+.5-v),B.push(m)}B.sort(Be),B.length>o&&(B.length=o);for(const s of B)s.used=q;for(const s of B){if(z>=tt)break;s.state==="queued"&&ye(s)}S.length=0;for(const s of g.values())s.used!==q&&(s.state==="queued"||s.state==="failed"?G(s):s.state==="ready"&&S.push(s));if(g.size>o){S.sort(ze);for(const s of S){if(g.size<=o)break;G(s)}}},ee={en:["house","apartments","commercial","industrial","civic","religious",""],es:["casa","apartamentos","comercial","industrial","cívico","religioso",""]},te={en:["","FEMA 0.2 % annual-chance zone","FEMA 1 % annual-chance zone","FEMA coastal high-hazard zone"],es:["","zona FEMA de 0.2 % anual","zona FEMA de 1 % anual","zona costera de alto riesgo FEMA"]},Me=(t,e,o,a)=>{let n=!1;const c=t.ringStart[e],r=t.ringStart[e+1],d=t.ring;for(let v=c,h=r-1;v<r;h=v++){const s=d[v*2],u=d[v*2+1],x=d[h*2],p=d[h*2+1];u>a!=p>a&&o<(x-s)*(a-u)/(p-u)+s&&(n=!n)}return n},He=t=>{if(!l.visible)return!1;const e=t.ground();if(!e)return!1;const o=t.origin,a=t.dir,n=e.distanceTo(o),c=Math.max(0,n-700),r=o.x+a.x*c,d=o.z+a.z*c,v=Math.min(r,e.x)-2,h=Math.max(r,e.x)+2,s=Math.min(d,e.z)-2,u=Math.max(d,e.z)+2;let x=n+4,p=null,b=-1;for(const _ of g.values()){const i=_.pick;if(!i||!_.mesh||!i.count)continue;const ne=v-i.cx,ie=h-i.cx,re=s-i.cz,ce=u-i.cz;if(ie<-2400||ne>2400||ce<-2400||re>2400)continue;const W=o.x-i.cx,D=o.z-i.cz,A=i.bbox,le=Oe(e.x,e.z);for(let f=0;f<i.count;f++){if(A[f*4]>ie||A[f*4+2]<ne||A[f*4+1]>ce||A[f*4+3]<re)continue;const fe=i.base[f]+i.height[f]-le,Fe=i.base[f]-ot-le;if(a.y<-1e-6){const w=(fe-o.y)/a.y;w>0&&w<x&&Me(i,f,W+a.x*w,D+a.z*w)&&(x=w,p=_,b=f)}const Le=i.ringStart[f],de=i.ringStart[f+1],T=i.ring;for(let w=Le,I=de-1;w<de;I=w++){const $=T[I*2],V=T[I*2+1],ue=T[w*2]-$,ve=T[w*2+1]-V,X=a.x*ve-a.z*ue;if(Math.abs(X)<1e-9)continue;const R=(($-W)*ve-(V-D)*ue)/X,he=(($-W)*a.z-(V-D)*a.x)/X;if(R<=0||R>=x||he<0||he>1)continue;const me=o.y+a.y*R;me>=Fe&&me<=fe&&(x=R,p=_,b=f)}}}if(!p||b<0)return!1;const m=p.pick,K=m.meta[b],k=Pe.value==="es",oe=(k?ee.es:ee.en)[K&7],ae=(k?te.es:te.en)[K>>3&3],Se=(K&32)!==0,L=[(k?"Edificio":"Building")+(oe?` (${oe})`:"")];L.push(`${m.height[b].toFixed(1)} m `+(Se?k?"(altura estimada)":"(height estimated)":k?"(altura de OpenStreetMap)":"(height from OpenStreetMap)")),m.ground[b]!==-32768&&L.push((k?"terreno ":"ground ")+(m.ground[b]/10).toFixed(1)+" m"),ae&&L.push(ae);const se=L.join(" · ");return xe.value!==se&&(xe.value=se),pe.value&&(pe.value=null),!0},Ce=M.onHover(10,He);return{update:t=>{O=t.now;const e=Ue.value.range,o=je.value.buildings!==!1&&e<Je;if(l.visible!==o&&(l.visible=o),!o)return;C.uBNight.value=y.night,C.uBSea.value=y.seaLevel,C.uBNfhl.value=Ge.value==="nfhl"?1:0;const a=((Ke.value/36e5+We)%24+24)%24,n=a>=18?Math.max(0,a-21.5):a+2.5;C.uBLit.value=a>6.5&&a<17?.25:be.clamp(.36-n*.06,.07,.36)+(a>5&&a<=6.5?.1:0),(t.index%8===0||J<0)&&(J=t.index,ke(e));for(const c of g.values()){if(!c.fading||!c.mesh)continue;let r=(O-c.born)/et;r>=1&&(r=1,c.fading=!1),r=r*r*(3-2*r),c.mesh.scale.y=Math.max(.02,r),c.mesh.position.y=(1-r)*c.yRef,c.mesh.updateMatrix()}},debug:()=>({tiles:j,buildings:P,triangles:U,pending:z+[...g.values()].filter(t=>t.state==="queued").length}),dispose(){F=!0,Ce(),E.terminate();for(const t of[...g.values()])G(t);y.scene.remove(l),Z.dispose()}}};export{it as createBuildings};
