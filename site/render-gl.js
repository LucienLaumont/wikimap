// WikiMap — rendu WebGL 2 de la carte : liens, zones de groupe, cartes. map.js garde la caméra, les
// gestes, les étiquettes et le reste de l'interface, et appelle WikiGL.create(canvas).
//
// Tout ce qui ne dépend que des données est envoyé une fois à la carte graphique : positions et
// attributs des cartes dans deux textures (une ligne de 256 cartes par rangée), liens en tampons
// (indices des deux bouts, poids). À chaque image, seuls la caméra et quelques réglages changent ; la
// carte graphique calcule elle-même les courbes des liens, les disques et leur lissage.
(() => {
  const TEX_W = 256;
  const HEAD = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
`;
  const COMMON = HEAD + `
uniform vec2 uView;      // taille de la vue, en points CSS
uniform vec3 uCam;       // caméra : centre x, y (unités de la carte), zoom k
uniform float uScale;    // pixels réels par point CSS pour ce dessin (dpr, ou résolution du calque des zones)
uniform float uKMin;     // zoom minimal pour la taille des points (vue de loin, ils restent visibles)
uniform sampler2D uPos;  // par carte : x, y, rayon (unités de la carte), force
uniform sampler2D uAttr; // par carte : opacité, groupe, rareté, drapeaux (1 visible, 2 zone de groupe)
uniform sampler2D uGroupCol;
ivec2 tc(int i) { return ivec2(i % ${TEX_W}, i / ${TEX_W}); }
vec2 toScreen(vec2 p) { return (p - uCam.xy) * uCam.z + uView * 0.5; }
vec4 toClip(vec2 s) { return vec4(s.x / uView.x * 2.0 - 1.0, 1.0 - s.y / uView.y * 2.0, 0.0, 1.0); }
const vec4 OFF = vec4(2.0, 2.0, 2.0, 1.0); // sommet rejeté hors de l'écran
`;

  // Liens : arc (courbe quadratique, milieu décalé de uCurve x la longueur, toujours du même côté),
  // découpé en uSeg segments ; chaque segment est un rectangle lissé sur ses bords. Mode 0 : couleur
  // unie (uColor) ; mode 1 : dégradé de la couleur du groupe d'un bout à celle de l'autre.
  const EDGE_VS = COMMON + `
in vec3 aEdge; // indices des deux bouts, poids
uniform int uSeg, uMode;
uniform float uCurve, uWA, uWB, uAlpha, uMinLen; // uMinLen : liens plus courts (px) non tracés
uniform vec3 uColor;
out vec4 vCol; out float vD, vHalf;
vec2 bez(vec2 a, vec2 q, vec2 b, float t) { float u = 1.0 - t; return u * u * a + 2.0 * u * t * q + t * t * b; }
void main() {
  int ia = int(aEdge.x), ib = int(aEdge.y);
  vec4 fa = texelFetch(uAttr, tc(ia), 0), fb = texelFetch(uAttr, tc(ib), 0);
  if ((int(fa.w) & 1) == 0 || (int(fb.w) & 1) == 0) { gl_Position = OFF; return; }
  vec2 p1 = toScreen(texelFetch(uPos, tc(ia), 0).xy), p2 = toScreen(texelFetch(uPos, tc(ib), 0).xy);
  if (abs(p2.x - p1.x) + abs(p2.y - p1.y) < uMinLen) { gl_Position = OFF; return; }
  vec2 q = (p1 + p2) * 0.5 + vec2(-(p2.y - p1.y), p2.x - p1.x) * uCurve;
  vec2 lo = min(min(p1, p2), q), hi = max(max(p1, p2), q);
  if (hi.x < -40.0 || hi.y < -40.0 || lo.x > uView.x + 40.0 || lo.y > uView.y + 40.0) { gl_Position = OFF; return; }
  int s = gl_VertexID / 6, c = gl_VertexID % 6;
  float t0 = float(s) / float(uSeg), t1 = float(s + 1) / float(uSeg);
  vec2 a0 = bez(p1, q, p2, t0), a1 = bez(p1, q, p2, t1);
  float w = (uWA + aEdge.z * uWB) * uScale;   // épaisseur en pixels réels
  float wd = max(w, 1.0), hw = wd * 0.5 + 0.5; // sous un pixel : un pixel, plus transparent
  vec2 d = a1 - a0; float L = length(d); d = L > 1e-4 ? d / L : vec2(1.0, 0.0);
  float side = (c == 2 || c == 3 || c == 5) ? 1.0 : -1.0;
  bool far = c == 1 || c == 4 || c == 5;
  vec2 P = (far ? a1 : a0) + vec2(-d.y, d.x) * side * hw / uScale;
  gl_Position = toClip(P);
  vD = side * hw; vHalf = wd * 0.5;
  vec3 col = uColor;
  if (uMode == 1) col = mix(texelFetch(uGroupCol, tc(int(fa.y)), 0).rgb, texelFetch(uGroupCol, tc(int(fb.y)), 0).rgb, far ? t1 : t0);
  vCol = vec4(col, uAlpha * min(1.0, w));
}`;
  const EDGE_FS = HEAD + `
in vec4 vCol; in float vD, vHalf; out vec4 o;
void main() { float a = vCol.a * clamp(vHalf + 0.5 - abs(vD), 0.0, 1.0); o = vec4(vCol.rgb * a, a); }`;

  // Cartes, un carré par carte où le disque est découpé et lissé. Passe 0 : zones de groupe (disque
  // large, opaque, sur le calque des zones) ; 1 : halos du thème sombre ; 2 : disque et anneau de rareté.
  const NODE_VS = COMMON + `
in float aIdx;
uniform int uPass, uColorMode, uRing;
uniform float uGlowMin;
uniform vec3 uRar[8];
out vec2 vOff; out float vR, vLw, vA; out vec3 vCol, vRingCol;
const vec2 Q[6] = vec2[6](vec2(-1, -1), vec2(1, -1), vec2(-1, 1), vec2(-1, 1), vec2(1, -1), vec2(1, 1));
void main() {
  int i = int(aIdx);
  vec4 P = texelFetch(uPos, tc(i), 0), A = texelFetch(uAttr, tc(i), 0);
  int fl = int(A.w);
  float r = P.z * max(uCam.z, uKMin), R = r;
  if ((fl & 1) == 0 || (uPass == 0 && (fl & 2) == 0) || (uPass == 1 && (r < 2.5 || P.w < uGlowMin))) { gl_Position = OFF; return; }
  if (uPass == 0) R = max(r * 2.6, 7.0); else if (uPass == 1) R = r * 2.4;
  vec2 c = toScreen(P.xy);
  float m = R + 1.5 / uScale;
  if (c.x + m < -50.0 || c.y + m < -50.0 || c.x - m > uView.x + 50.0 || c.y - m > uView.y + 50.0) { gl_Position = OFF; return; }
  vOff = Q[gl_VertexID] * m;
  gl_Position = toClip(c + vOff);
  vR = uPass == 0 ? R : r;
  vec3 gcol = texelFetch(uGroupCol, tc(int(A.y)), 0).rgb;
  vRingCol = uRar[int(A.z)];
  vCol = (uColorMode == 0 || uPass == 0) ? gcol : vRingCol;
  vLw = (uRing == 1 && r >= 3.5) ? max(1.0, r * 0.3) : 0.0;
  vA = A.x;
}`;
  const NODE_FS = HEAD + `
uniform int uPass; uniform float uScale, uGlow;
in vec2 vOff; in float vR, vLw, vA; in vec3 vCol, vRingCol; out vec4 o;
float disc(float R, float d) { return clamp((R - d) * uScale + 0.5, 0.0, 1.0); }
void main() {
  float d = length(vOff);
  if (uPass == 0) { float c = disc(vR, d); o = vec4(vCol * c, c); return; }
  if (uPass == 1) {
    float c1 = disc(vR * 2.4, d) * vA * uGlow * 0.5, c2 = disc(vR * 1.6, d) * vA * uGlow;
    float a = c2 + c1 * (1.0 - c2); o = vec4(vCol * a, a); return;
  }
  vec3 col = vLw > 0.0 ? mix(vCol, vRingCol, clamp((d - (vR - vLw)) * uScale + 0.5, 0.0, 1.0)) : vCol;
  float a = vA * disc(vR, d); o = vec4(col * a, a);
}`;

  // Pose du calque des zones sur la vue, en transparence
  const COMP_VS = HEAD + `
out vec2 vUV;
const vec2 T[3] = vec2[3](vec2(-1, -1), vec2(3, -1), vec2(-1, 3));
void main() { vUV = (T[gl_VertexID] + 1.0) * 0.5; gl_Position = vec4(T[gl_VertexID], 0.0, 1.0); }`;
  const COMP_FS = HEAD + `
uniform sampler2D uTex; uniform float uAlpha; in vec2 vUV; out vec4 o;
void main() { o = texture(uTex, vUV) * uAlpha; }`;

  function create(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) return null;
    const compile = (vs, fs) => {
      const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let k = 0; k < n; k++) { const name = gl.getActiveUniform(p, k).name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, name); }
      return { p, u };
    };
    let edge, node, comp;
    try { edge = compile(EDGE_VS, EDGE_FS); node = compile(NODE_VS, NODE_FS); comp = compile(COMP_VS, COMP_FS); } catch (e) { console.warn('WebGL :', e.message); return null; }

    const tex = (unit, internal, format, type) => {
      const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      return { t, unit, internal, format, type, set(data, n) {
        const h = Math.max(1, Math.ceil(n / TEX_W)), per = data.length / n, full = new data.constructor(TEX_W * h * per);
        full.set(data);
        gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, TEX_W, h, 0, format, type, full);
      } };
    };
    const posTex = tex(0, gl.RGBA32F, gl.RGBA, gl.FLOAT), attrTex = tex(1, gl.RGBA32F, gl.RGBA, gl.FLOAT), colTex = tex(2, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);

    // tampons d'instances : liens [a, b, poids] et ordre de dessin des cartes
    const instances = (prog, attr, size) => {
      const vao = gl.createVertexArray(), buf = gl.createBuffer(), loc = gl.getAttribLocation(prog.p, attr);
      gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(loc, 1);
      gl.bindVertexArray(null);
      return { vao, buf, count: 0, set(data) { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); this.count = data.length / size; } };
    };
    const intraE = instances(edge, 'aEdge', 3), interE = instances(edge, 'aEdge', 3), hiGroupE = instances(edge, 'aEdge', 3), hiCardE = instances(edge, 'aEdge', 3);
    const nodes = instances(node, 'aIdx', 1);
    const empty = gl.createVertexArray();

    // calque des zones de groupe
    const zoneTex = gl.createTexture(), fbo = gl.createFramebuffer();
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, zoneTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    let W = 1, H = 1, dpr = 1, zw = 1, zh = 1, zoneRes = 0.5;

    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const common = (prog, cam, scale, kMin) => {
      gl.useProgram(prog.p);
      gl.uniform2f(prog.u.uView, W, H); gl.uniform3f(prog.u.uCam, cam.x, cam.y, cam.k);
      gl.uniform1f(prog.u.uScale, scale);
      if (prog.u.uKMin) gl.uniform1f(prog.u.uKMin, kMin);
      if (prog.u.uPos) { gl.uniform1i(prog.u.uPos, 0); gl.uniform1i(prog.u.uAttr, 1); gl.uniform1i(prog.u.uGroupCol, 2); }
    };
    const drawEdges = (set, o, mode, color, alpha, wa, wb, seg, minLen = 0) => {
      if (!set.count) return;
      gl.uniform1f(edge.u.uMinLen, minLen);
      gl.uniform1i(edge.u.uMode, mode); gl.uniform3fv(edge.u.uColor, color); gl.uniform1f(edge.u.uAlpha, alpha);
      gl.uniform1f(edge.u.uWA, wa); gl.uniform1f(edge.u.uWB, wb); gl.uniform1i(edge.u.uSeg, seg); gl.uniform1f(edge.u.uCurve, o.curve);
      gl.bindVertexArray(set.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, seg * 6, set.count);
    };

    return {
      // n cartes ; pos : Float32Array [x, y, rayon, force] x n ; order : indices dans l'ordre de dessin
      setGraph(n, pos, order, intra, inter) { this.n = n; posTex.set(pos, n); nodes.set(order); intraE.set(intra); interE.set(inter); },
      setPositions(pos) { posTex.set(pos, this.n); },
      setGroupColors(rgba, ng) { colTex.set(rgba, ng); },
      // attr : Float32Array [opacité, groupe, rareté, drapeaux] x n ; liens mis en avant (groupe, carte)
      setState(attr, hiGroup, hiCard) { attrTex.set(attr, this.n); hiGroupE.set(hiGroup); hiCardE.set(hiCard); },
      resize(w, h, d, zr) {
        W = w; H = h; dpr = d; zoneRes = zr;
        canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
        zw = Math.max(1, Math.ceil(W * zoneRes)); zh = Math.max(1, Math.ceil(H * zoneRes));
        gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, zoneTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, zw, zh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, zoneTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      },
      // o : réglages de l'image (couleurs, opacités, courbure, segments par lien, etc., voir map.js)
      render(cam, o) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        common(edge, cam, dpr, o.kMin);
        drawEdges(intraE, o, 0, o.edge, o.intraAlpha, 0.5, 0, o.intraSeg, 3); // sous 3 px, perdus sous les zones
        if (o.showInter) drawEdges(interE, o, 1, o.edge, o.linkAlpha, 0.5, 2.5, o.interSeg);
        // zones : disques opaques sur le calque, puis posés en transparence
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, zw, zh); gl.clear(gl.COLOR_BUFFER_BIT);
        common(node, cam, zoneRes, o.kMin);
        gl.uniform1i(node.u.uPass, 0); gl.bindVertexArray(nodes.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, nodes.count);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(comp.p); gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, zoneTex);
        gl.uniform1i(comp.u.uTex, 3); gl.uniform1f(comp.u.uAlpha, o.zoneAlpha);
        gl.bindVertexArray(empty); gl.drawArrays(gl.TRIANGLES, 0, 3);
        // liens mis en avant : ceux du groupe choisi, ou ceux de la carte choisie (en dégradé tous les deux)
        common(edge, cam, dpr, o.kMin);
        drawEdges(hiGroupE, o, 1, o.edge, 0.85, 0.8, 4, 8);
        drawEdges(hiCardE, o, 1, o.accent, 0.75, 0.8, 5, 8); // dégradé : groupe de la carte choisie -> groupe de la voisine
        // cartes : halos (thème sombre), puis disques et anneaux
        common(node, cam, dpr, o.kMin);
        gl.uniform1i(node.u.uColorMode, o.colorMode); gl.uniform1i(node.u.uRing, o.ring);
        gl.uniform1f(node.u.uGlow, o.glow); gl.uniform1f(node.u.uGlowMin, o.glowMin); gl.uniform3fv(node.u.uRar, o.rar);
        gl.bindVertexArray(nodes.vao);
        if (o.glow > 0) { gl.uniform1i(node.u.uPass, 1); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, nodes.count); }
        gl.uniform1i(node.u.uPass, 2); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, nodes.count);
        gl.bindVertexArray(null);
      },
      lost: () => gl.isContextLost(),
    };
  }
  window.WikiGL = { create };
})();
