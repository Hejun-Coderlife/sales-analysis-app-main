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
      const dataResponse = await fetch("/api/public/earth-edges-data", { credentials: "same-origin" });
      if (dataResponse.ok) {
        const payload = await dataResponse.json().catch(function(){ return {}; });
        const value = payload && typeof payload.data === "string" ? payload.data.trim() : "";
        if (value) return value;
      }
    } catch (_error) {}
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
    section.innerHTML =
      '<div class="earth-stage"><div id="earth-canvas"></div></div><div class="earth-caption">GLOBAL BUSINESS NETWORK<span class="earth-hint">DRAG TO ROTATE · SCROLL TO ZOOM</span></div>';
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
        const coreGeo = new THREE.SphereGeometry(1, 72, 72);
        const coreMat = new THREE.MeshBasicMaterial({ color: 0x0e0a24 });
        earth.add(new THREE.Mesh(coreGeo, coreMat));

        const edgeImg = new Image();
        const edgeTex = new THREE.Texture(edgeImg);
        edgeImg.onload = function(){ edgeTex.needsUpdate = true; };
        edgeImg.src = "data:image/png;base64," + (edgesData || "");
        const edgeGeo = new THREE.SphereGeometry(1.004, 72, 72);
        const edgeMat = new THREE.MeshBasicMaterial({
          map: edgeTex,
          color: 0xd8b4fe,
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        });
        earth.add(new THREE.Mesh(edgeGeo, edgeMat));

        function latLngToVec3(lat, lng, r){
          const phi = (90 - lat) * Math.PI / 180;
          const theta = (lng + 180) * Math.PI / 180;
          return new THREE.Vector3(
            -r * Math.sin(phi) * Math.cos(theta),
             r * Math.cos(phi),
             r * Math.sin(phi) * Math.sin(theta)
          );
        }

        const CITIES = [
          [40.71,-74.00],[34.05,-118.24],[41.88,-87.63],[29.76,-95.37],[25.76,-80.19],
          [37.77,-122.42],[47.60,-122.33],[43.65,-79.38],[45.50,-73.56],[49.28,-123.12],
          [19.43,-99.13],[23.13,-82.38],[21.31,-157.86],
          [10.48,-66.90],[4.71,-74.07],[-12.04,-77.03],[-33.45,-70.67],
          [-34.60,-58.38],[-22.91,-43.17],[-23.55,-46.63],[-12.97,-38.51],
          [51.51,-0.13],[48.86,2.35],[40.42,-3.70],[41.39,2.17],[38.72,-9.14],
          [53.35,-6.26],[52.37,4.90],[52.52,13.40],[48.14,11.58],[50.45,30.52],
          [41.90,12.50],[37.98,23.73],[41.01,28.98],[55.76,37.62],[59.33,18.06],
          [59.91,10.75],[60.17,24.94],[52.23,21.01],[50.08,14.44],[48.21,16.37],
          [30.04,31.24],[6.52,3.38],[-1.29,36.82],[-26.20,28.04],[-33.92,18.42],
          [33.57,-7.59],[15.50,32.56],[9.03,38.74],[14.69,-17.44],
          [25.27,55.30],[24.47,39.61],[35.68,51.39],[33.31,44.36],[31.77,35.21],
          [19.07,72.87],[28.61,77.20],[12.97,77.59],[22.57,88.36],
          [13.75,100.49],[1.35,103.82],[-6.21,106.85],[14.60,120.98],
          [22.32,114.17],[39.90,116.40],[31.23,121.47],[35.68,139.69],
          [37.57,126.98],[25.03,121.56],[21.03,105.85],[10.82,106.63],
          [-33.87,151.21],[-37.81,144.96],[-36.85,174.76],[-27.47,153.02]
        ];
        const cityVecs = CITIES.map(function(coords){
          return latLngToVec3(coords[0], coords[1], 1.012);
        });

        const dotPos = new Float32Array(cityVecs.length * 3);
        cityVecs.forEach(function(v, i){
          dotPos[i * 3] = v.x;
          dotPos[i * 3 + 1] = v.y;
          dotPos[i * 3 + 2] = v.z;
        });
        const dotGeo = new THREE.BufferGeometry();
        dotGeo.setAttribute("position", new THREE.BufferAttribute(dotPos, 3));
        earth.add(new THREE.Points(dotGeo, new THREE.PointsMaterial({
          color: 0xf0abfc,
          size: 0.034,
          transparent: true,
          opacity: 0.95,
          sizeAttenuation: true,
          depthWrite: false
        })));

        function makeArc(a, b, color, opacity){
          const mid = a.clone().add(b).multiplyScalar(0.5);
          const dist = a.distanceTo(b);
          const lift = 1 + Math.min(0.65, dist * 0.42);
          mid.normalize().multiplyScalar(lift);
          const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
          const pts = curve.getPoints(64);
          const geo = new THREE.BufferGeometry().setFromPoints(pts);
          const mat = new THREE.LineBasicMaterial({
            color: color,
            transparent: true,
            opacity: opacity,
            depthWrite: false
          });
          return { line: new THREE.Line(geo, mat), curve: curve };
        }

        for (let i = 0; i < 42; i++){
          const a = cityVecs[Math.floor(Math.random() * cityVecs.length)];
          const b = cityVecs[Math.floor(Math.random() * cityVecs.length)];
          if (a === b) continue;
          earth.add(makeArc(a, b, 0xa78bfa, 0.32).line);
        }

        const pulses = [];
        for (let i = 0; i < 10; i++){
          const a = cityVecs[Math.floor(Math.random() * cityVecs.length)];
          const b = cityVecs[Math.floor(Math.random() * cityVecs.length)];
          if (a === b) { i -= 1; continue; }
          const arc = makeArc(a, b, 0xe879f9, 0.85);
          earth.add(arc.line);
          const pulse = new THREE.Mesh(
            new THREE.SphereGeometry(0.02, 10, 10),
            new THREE.MeshBasicMaterial({ color: 0xfdf4ff, transparent: true, opacity: 0.95 })
          );
          earth.add(pulse);
          pulses.push({
            curve: arc.curve,
            mesh: pulse,
            t: Math.random(),
            speed: 0.003 + Math.random() * 0.004
          });
        }

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
          for (let i = 0; i < pulses.length; i++){
            const p = pulses[i];
            p.t += p.speed;
            if (p.t > 1) p.t = 0;
            p.mesh.position.copy(p.curve.getPoint(p.t));
            const fade = Math.sin(p.t * Math.PI);
            p.mesh.material.opacity = 0.3 + 0.7 * fade;
            p.mesh.scale.setScalar(0.5 + 0.9 * fade);
          }
          renderer.render(scene, camera);
        }
        animate();

        function resize(){
          const r = mount.getBoundingClientRect();
          const s = Math.max(1, Math.round(Math.min(r.width, r.height)));
          renderer.setSize(s, s, true);
          renderer.domElement.style.width = s + "px";
          renderer.domElement.style.height = s + "px";
          camera.aspect = 1;
          camera.updateProjectionMatrix();
        }
        window.addEventListener("resize", resize);
        if (window.ResizeObserver){
          try { new ResizeObserver(resize).observe(mount); } catch (e) {}
        }
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
