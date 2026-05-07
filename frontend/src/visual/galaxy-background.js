(function(){
  function ensureSpaceBackground(){
    if (document.querySelector(".space-bg")) return;
    const host = document.createElement("div");
    host.className = "space-bg";
    host.setAttribute("aria-hidden", "true");
    host.innerHTML = [
      '<div class="sci-grid"></div>',
      '<div class="nebula nebula-1"></div>',
      '<div class="nebula nebula-2"></div>',
      '<div class="nebula nebula-3"></div>',
      '<div class="galaxy-wrap"><div class="galaxy"></div></div>',
      '<div class="orbit orbit-3"></div>',
      '<div class="orbit orbit-2"></div>',
      '<div class="orbit orbit-1"></div>',
      '<canvas id="starfield"></canvas>',
      '<div class="shooting-star shooting-1"></div>',
      '<div class="shooting-star shooting-2"></div>',
      '<div class="shooting-star shooting-3"></div>'
    ].join("");
    document.body.insertBefore(host, document.body.firstChild);
  }

  function initStarfield(){
    const canvas = document.getElementById("starfield");
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext("2d");
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0, stars = [];
    const STAR_COUNT = 260;
    const COLORS = ["#ffffff","#ffffff","#ffffff","#dbeafe","#fde68a","#a5b4fc","#f5d0fe","#bae6fd"];

    function resize(){
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * DPR;
      canvas.height = H * DPR;
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      stars = [];
      for (let i = 0; i < STAR_COUNT; i++){
        stars.push({
          x: Math.random() * W,
          y: Math.random() * H,
          r: Math.random() * 1.3 + 0.2,
          a: Math.random() * 0.6 + 0.3,
          speed: Math.random() * 0.018 + 0.004,
          phase: Math.random() * Math.PI * 2,
          color: COLORS[Math.floor(Math.random() * COLORS.length)],
          drift: (Math.random() - 0.5) * 0.02
        });
      }
    }
    resize();
    window.addEventListener("resize", resize);

    function tick(t){
      ctx.clearRect(0, 0, W, H);
      const time = t * 0.001;
      for (let i = 0; i < stars.length; i++){
        const s = stars[i];
        const alpha = Math.max(0, Math.min(1, s.a + Math.sin(time * s.speed * 40 + s.phase) * 0.45));
        ctx.globalAlpha = alpha;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
        s.x += s.drift;
        if (s.x < -5) s.x = W + 5;
        if (s.x > W + 5) s.x = -5;
        if (s.r > 1.1){
          ctx.globalAlpha = alpha * 0.35;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r * 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(tick);
    }
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches){
      for (let i = 0; i < stars.length; i++){
        const s = stars[i];
        ctx.globalAlpha = s.a;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else {
      requestAnimationFrame(tick);
    }
  }

  async function getEarthEdgesData(){
    const inline = document.getElementById("earth-edges-data");
    if (inline && inline.textContent) return inline.textContent.trim();
    try {
      const html = await fetch("/index.html", { credentials: "same-origin" }).then((r) => r.text());
      const m = html.match(/<script id="earth-edges-data" type="text\/plain">([\s\S]*?)<\/script>/);
      return m && m[1] ? m[1].trim() : "";
    } catch (error) {
      return "";
    }
  }

  function ensureEarthSection(){
    if (document.querySelector(".earth-section")) return;
    const section = document.createElement("section");
    section.className = "earth-section";
    section.setAttribute("aria-hidden", "true");
    section.innerHTML = '<div class="earth-stage"><div id="earth-canvas"></div></div><div class="earth-caption">全球业务网络<span class="earth-hint">拖动旋转 · 滚轮缩放</span></div>';
    const footer = document.querySelector("footer");
    if (footer && footer.parentNode) {
      footer.parentNode.insertBefore(section, footer);
    } else {
      document.body.appendChild(section);
    }
  }

  function ensureThreeScript(cb){
    if (window.THREE) return cb();
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
    script.onload = cb;
    document.head.appendChild(script);
  }

  function initEarthWithData(edgesData){
    (function initEarth(){
      if (!window.THREE) return setTimeout(initEarth, 50);
      const mount = document.getElementById("earth-canvas");
      if (!mount) return;
      function waitForSize(cb){
        const r = mount.getBoundingClientRect();
        if (r.width >= 20 && r.height >= 20) return cb(Math.round(r.width), Math.round(r.height));
        requestAnimationFrame(function(){ waitForSize(cb); });
      }
      waitForSize(function(W, H){
        const SIZE = Math.min(W, H);
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
        camera.position.set(0, 0, 3.3);
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(SIZE, SIZE, true);
        renderer.setClearColor(0x000000, 0);
        renderer.domElement.style.display = "block";
        renderer.domElement.style.width = SIZE + "px";
        renderer.domElement.style.height = SIZE + "px";
        renderer.domElement.style.margin = "0 auto";
        mount.appendChild(renderer.domElement);

        const earth = new THREE.Group();
        scene.add(earth);
        earth.add(new THREE.Mesh(new THREE.SphereGeometry(1, 72, 72), new THREE.MeshBasicMaterial({ color: 0x0e0a24 })));

        const edgeImg = new Image();
        const edgeTex = new THREE.Texture(edgeImg);
        edgeImg.onload = function(){ edgeTex.needsUpdate = true; };
        edgeImg.src = "data:image/png;base64," + edgesData;
        earth.add(new THREE.Mesh(new THREE.SphereGeometry(1.004, 72, 72), new THREE.MeshBasicMaterial({
          map: edgeTex, color: 0xd8b4fe, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false
        })));

        scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.22, 64, 64), new THREE.ShaderMaterial({
          transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
          vertexShader: "varying vec3 vNormal;void main(){ vNormal = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
          fragmentShader: "varying vec3 vNormal;void main(){ float i = pow(0.60 - dot(vNormal, vec3(0.0,0.0,1.0)), 2.2); gl_FragColor = vec4(0.82, 0.52, 1.00, 1.0) * i; }"
        })));

        let isDragging = false, px = 0, py = 0, velX = 0, velY = 0;
        let autoRotate = true, resumeTimer = null;
        const MAX_X = Math.PI / 2 - 0.15;
        function onDown(e){ isDragging = true; autoRotate = false; clearTimeout(resumeTimer); const p = e.touches ? e.touches[0] : e; px = p.clientX; py = p.clientY; velX = 0; velY = 0; }
        function onMove(e){
          if (!isDragging) return;
          const p = e.touches ? e.touches[0] : e;
          const dx = p.clientX - px, dy = p.clientY - py;
          earth.rotation.y += dx * 0.006;
          earth.rotation.x += dy * 0.006;
          earth.rotation.x = Math.max(-MAX_X, Math.min(MAX_X, earth.rotation.x));
          velY = dx * 0.006; velX = dy * 0.006;
          px = p.clientX; py = p.clientY;
        }
        function onUp(){ if (!isDragging) return; isDragging = false; clearTimeout(resumeTimer); resumeTimer = setTimeout(function(){ autoRotate = true; }, 2400); }
        mount.addEventListener("mousedown", onDown);
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        mount.addEventListener("touchstart", onDown, { passive: true });
        window.addEventListener("touchmove", onMove, { passive: true });
        window.addEventListener("touchend", onUp);
        mount.addEventListener("wheel", function(e){ e.preventDefault(); camera.position.z = Math.max(2.3, Math.min(5.5, camera.position.z + e.deltaY * 0.002)); }, { passive: false });

        function animate(){
          requestAnimationFrame(animate);
          if (autoRotate && !isDragging) earth.rotation.y += 0.0018;
          else if (!isDragging){
            velY *= 0.94; velX *= 0.94;
            earth.rotation.y += velY;
            earth.rotation.x += velX;
            earth.rotation.x = Math.max(-MAX_X, Math.min(MAX_X, earth.rotation.x));
          }
          renderer.render(scene, camera);
        }
        animate();
      });
    })();
  }

  function initGalaxyBackground(options){
    const opts = Object.assign({ includeEarth: false, mapAssistantButton: false }, options || {});
    ensureSpaceBackground();
    initStarfield();
    if (opts.mapAssistantButton){
      const chatFab = document.getElementById("chatFab");
      if (chatFab) chatFab.classList.add("ai-test-launcher");
    }
    if (opts.includeEarth){
      ensureEarthSection();
      getEarthEdgesData().then(function(data){
        ensureThreeScript(function(){ initEarthWithData(data || ""); });
      });
    }
  }

  window.initGalaxyBackground = initGalaxyBackground;
})();
