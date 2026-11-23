(() => {
  'use strict';

  // ======================= KONFIGURACJA =======================
  const CHUNK = 64;                      // rozmiar chunka (jednostki świata)
  const LOD_RES = [32, 16, 8, 4];        // liczba segmentów chunka dla poziomów szczegółowości
  const LOD_DIST = [3.3, 6.2, 9.4];      // progi odległości (w chunkach) między poziomami LOD
  const UNLOAD_MARGIN = 1;               // chunki dalsze niż zasięg + tyle są usuwane z pamięci i GPU
  const WATER_LEVEL = 0;                 // poziom wody
  const TREE_LINE = 130;                 // powyżej tej wysokości nie rosną drzewa
  const EYE_HEIGHT = 1.8;
  const GRAVITY = 32;                    // grawitacja gracza (arcade); samochód ma prawdziwe 9.81
  const JUMP_SPEED = 11;
  const WALK_SPEED = 9;
  const SPRINT_SPEED = 18;
  const FLY_SPEED = 70;
  const FLY_FAST_SPEED = 320;
  const BASE_SENS = 0.0022;
  const FRAME_BUDGET_MS = 7;             // ile ms na klatkę wolno poświęcić na budowę chunków

  // miasta
  const CITY_CELL = 960;     // w każdej takiej komórce może powstać jedno miasto
  const CITY_BLEND = 90;     // szerokość pasa łączącego płaskie miasto z terenem
  const BLOCK = 24;          // rozmiar kwartału (ulica + zabudowa)
  const ROAD_W = 6;          // szerokość ulicy
  const ROAD_HW = ROAD_W / 2;

  // drogi między miastami
  const MAX_ROAD_DIST = 2700; // maksymalna odległość miast połączonych drogą
  const ROAD_LINKS = 2;       // do ilu najbliższych miast prowadzi droga z każdego miasta
  const ROAD_STEP = 3;        // gęstość próbkowania drogi (jednostki świata)

  // tunele
  const ROAD_GRADE = 0.11;    // maksymalne nachylenie projektowe drogi w tunelu
  const TUN_EDGE = 0.6;       // od tej głębokości (pod powierzchnią) zaczyna się wykop (droga poniżej terenu)
  const TUN_CORE = 15.0;      // wykop musi być głębszy niż to, żeby powstał tunel
  const TUN_HALF_W = 4.0;     // połowa szerokości wnętrza tunelu
  const TUN_WALL_H = 2.6;     // wysokość pionowych ścian wnętrza
  const TUN_ARCH_H = 3.2;     // wysokość łuku sklepienia
  const TUN_H = TUN_WALL_H + TUN_ARCH_H;   // wysokość wnętrza w zenicie
  const TUN_COVER = TUN_H + 1.7;           // tyle gruntu nad drogą potrzeba, by tunel był zasypany
  const PIT_HALF_W = 5.2;     // połowa szerokości otwartego wykopu przed portalem
  const FACADE_HALF_W = 8.6;  // połowa szerokości betonowej ściany portalu
  const XSLOPE_TOL = 0.45;    // maks. różnica wysokości krawędzi jezdni względem osi (przechył poprzeczny ≈ 8°)
  const PIT_SLOPE = 1.0;      // nachylenie skarp wykopu (1 = 45°)
  const CARVE_CELL = 32;      // rozmiar komórki indeksu wykopów
  const CARVE_REACH = PIT_HALF_W + TUN_CORE + 3;  // jak daleko od osi drogi teren może być obniżony

  // ======================= USTAWIENIA (MENU) =======================
  const SETTINGS_KEY = 'perlin-world-settings-v3';
  const DEFAULTS = {
    viewDist: 9,          // zasięg widzenia w chunkach
    fov: 72,
    sens: 1.0,
    invertY: false,
    units: 'kmh',
    renderScale: 1.0,
    timeOfDay: 11,        // godzina 0-24
    dayCycle: false,
    assists: true,        // ABS + kontrola trakcji
    autoGear: true,
    shake: true,
    showHud: true,
    mountainScale: 1.0,   // skala wysokości gór (dla nowych światów)
    cityDensity: 0.5,     // szansa na miasto w komórce (dla nowych światów)
    seed: ''
  };
  let settings = Object.assign({}, DEFAULTS);
  try {
    const raw = window.localStorage && window.localStorage.getItem(SETTINGS_KEY);
    if (raw) settings = Object.assign(settings, JSON.parse(raw));
  } catch (e) { /* tryb prywatny / brak storage – ustawienia tylko na czas sesji */ }
  function saveSettings() {
    try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignoruj */ }
  }
  const viewDist = () => clamp(Math.round(settings.viewDist), 4, 14);
  const unload2 = () => (viewDist() + UNLOAD_MARGIN) * (viewDist() + UNLOAD_MARGIN);

  // ======================= SZUM PERLINA =======================
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Perlin {
    constructor(seed) {
      const rand = mulberry32(seed);
      const p = new Uint8Array(256);
      for (let i = 0; i < 256; i++) p[i] = i;
      for (let i = 255; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [p[i], p[j]] = [p[j], p[i]];
      }
      this.p = new Uint8Array(512);
      for (let i = 0; i < 512; i++) this.p[i] = p[i & 255];
    }

    static fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
    static lerp(t, a, b) { return a + t * (b - a); }
    static grad(h, x, y) {
      switch (h & 7) {
        case 0: return x + y;
        case 1: return -x + y;
        case 2: return x - y;
        case 3: return -x - y;
        case 4: return x;
        case 5: return -x;
        case 6: return y;
        default: return -y;
      }
    }

    // zwraca wartość mniej więcej z przedziału [-1, 1]
    noise(x, y) {
      const p = this.p;
      const fx = Math.floor(x), fy = Math.floor(y);
      const X = fx & 255, Y = fy & 255;
      x -= fx; y -= fy;
      const u = Perlin.fade(x), v = Perlin.fade(y);
      const aa = p[p[X] + Y], ab = p[p[X] + Y + 1];
      const ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1];
      return Perlin.lerp(v,
        Perlin.lerp(u, Perlin.grad(aa, x, y), Perlin.grad(ba, x - 1, y)),
        Perlin.lerp(u, Perlin.grad(ab, x, y - 1), Perlin.grad(bb, x - 1, y - 1))
      );
    }

    // fractal Brownian motion – kilka oktaw szumu
    fbm(x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
      let sum = 0, amp = 1, freq = 1, norm = 0;
      for (let i = 0; i < octaves; i++) {
        sum += this.noise(x * freq, y * freq) * amp;
        norm += amp;
        amp *= gain;
        freq *= lacunarity;
      }
      return sum / norm;
    }
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth01 = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;

  // ======================= ŚWIAT =======================
  const world = { seed: 0, mScale: 1, cityChance: 0.5 };
  let seed = 0;
  let perlin = new Perlin(1);

  function seedFromString(s) {
    s = String(s).trim();
    if (/^-?\d+$/.test(s)) return (parseInt(s, 10) >>> 0) % 2147483647;
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) % 2147483647;
  }

  function hash2(a, b) {
    let h = (a * 374761393 + b * 668265263 + seed) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }

  // wysokość surowego terenu: łagodne niziny i wzgórza + potężne, wysokie pasma górskie
  function terrainHeight(x, z) {
    const ms = world.mScale;
    const base = perlin.fbm(x * 0.0011, z * 0.0011, 4, 2, 0.4);
    let h = base * 115 + 20;

    // maska gór (bardzo duża skala) + zaokrąglone grzbiety (ridged noise): szczyty do ~550 jednostek
    const mm = perlin.fbm(x * 0.00055 + 100, z * 0.00055 + 100, 3);
    const mask = smooth01(0.16, 0.48, mm);
    const n = perlin.fbm(x * 0.0016 + 50, z * 0.0016 + 50, 5, 2, 0.5);
    const rid = Math.max(0, 1 - Math.sqrt(n * n + 0.02));
    h += mask * (Math.pow(rid, 1.8) * 520 + 30) * ms;

    // drobne nierówności
    h += perlin.noise(x * 0.012, z * 0.012) * 4 + perlin.noise(x * 0.05, z * 0.05) * 1.2;
    return h;
  }

  // ======================= MIASTA =======================
  const cityCache = new Map();
  const treeSolids = new Map();   // pnie drzew [x, z, promień, ...] do kolizji z samochodem (per chunk)
  const roadSegs = new Map();     // powierzchnie dróg i mostów (per chunk)
  const buildBoxes = new Map();   // kolizje budynków (per chunk)

  // ---- style miast: każde miasto losuje styl, paletę, wielkość kwartału, liczbę i położenie centrów zabudowy ----
  // towerAt / midAt – próg gęstości (0..1), od którego stawiane są wieżowce / budynki średnie; tall – skala wysokości
  const CITY_STYLES = [
    { name: 'metropolia', w: 0.17, rMin: 150, rMax: 195, P: [24, 28], towerAt: 0.4, midAt: 0.2, tall: 1.5, park: 0.05, hubs: [2, 3] },
    { name: 'miasto', w: 0.28, rMin: 115, rMax: 175, P: [22, 26], towerAt: 0.62, midAt: 0.3, tall: 1.0, park: 0.07, hubs: [1, 2] },
    { name: 'miasteczko', w: 0.27, rMin: 85, rMax: 130, P: [18, 22], towerAt: 9, midAt: 0.55, tall: 0.45, park: 0.1, hubs: [1, 1] },
    { name: 'dzielnica przemysłowa', w: 0.12, rMin: 105, rMax: 160, P: [26, 32], towerAt: 9, midAt: 9, tall: 0.6, park: 0.03, hubs: [1, 2], industrial: true },
    { name: 'stare miasto', w: 0.16, rMin: 95, rMax: 140, P: [16, 20], towerAt: 9, midAt: 0.3, tall: 0.7, park: 0.05, hubs: [1, 2], old: true }
  ];
  const PALETTES = [
    { glass: [0x8fa6b8, 0x6f8aa0, 0xa9b9c4, 0x7d8f9c], mid: [0xc9b79c, 0xd8d0c0, 0x9aa5ad, 0xb5b8bd], house: [0xe8dcc0, 0xc7d3d9, 0xf0e6d6, 0xd7dde0], roof: [0x4a5560, 0x5b4a3a, 0x6b6e73], conc: [0x9a9a98, 0xaaa79f, 0x8d8f93] },
    { glass: [0xb3a99a, 0xa59274, 0xc2b49a, 0x9a8b78], mid: [0xb5654a, 0xc98a62, 0xd9b38a, 0xa8553f], house: [0xe0b08a, 0xd9a07a, 0xefd2a8, 0xc98a62], roof: [0x9c4a32, 0xb25a3a, 0x8b3a2f], conc: [0xb2a58f, 0xa39682, 0xbdb09a] },
    { glass: [0x9bb0a8, 0x7fa095, 0xb0c4bb, 0x6f9488], mid: [0xe3d9c3, 0xf0ead8, 0xc5d3c0, 0xd6d0be], house: [0xf1ece0, 0xb8c9a5, 0xe9e1c8, 0xd8e2d0], roof: [0x3f4a44, 0x55604f, 0x6e4a38], conc: [0x9aa095, 0xa8ada0, 0x8c9488] },
    { glass: [0x7d8f9c, 0x56687a, 0x8996a3, 0x62727f], mid: [0x8a8e94, 0x9a8f86, 0xb0a79c, 0x74787e], house: [0xc9c6bd, 0xb7b4ab, 0xdad6cb, 0xa9a69d], roof: [0x3a3d42, 0x4a4d52, 0x2f3236], conc: [0x7d7f82, 0x8d8f93, 0x6e7073] },
    { glass: [0xb9c6d3, 0x9fb2c4, 0xcbd6e0, 0x8ea4b8], mid: [0xe8c97a, 0xd9856a, 0x8fb0c7, 0xe9e4d4], house: [0xf3d99b, 0xe58f7b, 0x9fc3d6, 0xf1ede0], roof: [0x7a3b2e, 0x2f4f6b, 0x5c5f66], conc: [0xa9aeb2, 0xb8bcbf, 0x9ca1a6] }
  ];

  // Każda komórka CITY_CELL ma deterministycznie (seed) co najwyżej jedno miasto.
  function getCity(ci, cj) {
    const key = ci * 100003 + cj;
    const cached = cityCache.get(key);
    if (cached !== undefined) return cached.city;

    let city = null;
    const rand = mulberry32(hash2(ci * 7919 + 13, cj * 104729 + 7));
    if (rand() < world.cityChance) {
      const x = (ci + 0.3 + rand() * 0.4) * CITY_CELL;
      const z = (cj + 0.3 + rand() * 0.4) * CITY_CELL;
      let wr = rand(), si = 0;
      for (; si < CITY_STYLES.length - 1; si++) { wr -= CITY_STYLES[si].w; if (wr <= 0) break; }
      const S = CITY_STYLES[si];
      const r = lerp(S.rMin, S.rMax, rand());
      const P = Math.round(lerp(S.P[0], S.P[1], rand()));
      const pal = Math.floor(rand() * PALETTES.length);
      const tall = S.tall * (0.8 + rand() * 0.5);
      const nh = S.hubs[0] + Math.floor(rand() * (S.hubs[1] - S.hubs[0] + 1));
      const hubs = [{ x: x + (rand() - 0.5) * r * 0.25, z: z + (rand() - 0.5) * r * 0.25, r: r * (0.6 + rand() * 0.3) }];
      for (let q = 1; q < nh; q++) {
        const a = rand() * Math.PI * 2, d = r * (0.3 + rand() * 0.25);
        hubs.push({ x: x + Math.cos(a) * d, z: z + Math.sin(a) * d, r: r * (0.3 + rand() * 0.2) });
      }
      const h = terrainHeight(x, z);
      let ok = h > 4 && h < 70;
      let maxDiff = 0;
      for (let ring = 0; ring < 2 && ok; ring++) {
        const rr = ring ? r * 1.6 : r * 0.9;
        for (let a = 0; a < 8; a++) {
          const px = x + Math.cos(a * Math.PI / 4) * rr;
          const pz = z + Math.sin(a * Math.PI / 4) * rr;
          const ph = terrainHeight(px, pz);
          if (ph < WATER_LEVEL - 6) ok = false;
          maxDiff = Math.max(maxDiff, Math.abs(ph - h));
        }
      }
      if (maxDiff > 38) ok = false;
      if (ok) city = { x, z, r, h, ci, cj, id: ci + ',' + cj, links: null, style: si, P, pal, tall, hubs };
    }
    cityCache.set(key, { city, ci, cj });
    return city;
  }

  // wysokość bazowa: teren spłaszczony pod miastem i płynnie przechodzący w otoczenie (bez wykopów drogowych)
  function baseHeight(x, z) {
    const raw = terrainHeight(x, z);
    const c = getCity(Math.floor(x / CITY_CELL), Math.floor(z / CITY_CELL));
    if (!c) return raw;
    const d = Math.hypot(x - c.x, z - c.z);
    if (d <= c.r) return c.h;
    if (d >= c.r + CITY_BLEND) return raw;
    const t = (d - c.r) / CITY_BLEND;
    const s = t * t * (3 - 2 * t);
    return c.h + (raw - c.h) * s;
  }

  // ---- wykopy drogowe: odcinki osi drogi, wzdłuż których teren jest obniżany do poziomu jezdni ----
  const carveIdx = new Map();   // komórka CARVE_CELL x CARVE_CELL -> tablica odcinków
  const carveKey = (i, j) => (i + 32768) * 65536 + (j + 32768);

  // seg: { ax, az, ay, bx, bz, by, lo, hi, road }; lo/hi ograniczają rzut na odcinek (portal = twardy koniec)
  function addCarveSeg(seg) {
    const abx = seg.bx - seg.ax, abz = seg.bz - seg.az;
    seg.abx = abx; seg.abz = abz;
    seg.l2 = abx * abx + abz * abz || 1;
    const i0 = Math.floor((Math.min(seg.ax, seg.bx) - CARVE_REACH) / CARVE_CELL);
    const i1 = Math.floor((Math.max(seg.ax, seg.bx) + CARVE_REACH) / CARVE_CELL);
    const j0 = Math.floor((Math.min(seg.az, seg.bz) - CARVE_REACH) / CARVE_CELL);
    const j1 = Math.floor((Math.max(seg.az, seg.bz) + CARVE_REACH) / CARVE_CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = carveKey(i, j);
        let a = carveIdx.get(k);
        if (!a) { a = []; carveIdx.set(k, a); }
        a.push(seg);
      }
    }
  }

  function removeCarveRoad(roadKey, cellBox) {
    const i0 = Math.floor(cellBox.minx / CARVE_CELL), i1 = Math.floor(cellBox.maxx / CARVE_CELL);
    const j0 = Math.floor(cellBox.minz / CARVE_CELL), j1 = Math.floor(cellBox.maxz / CARVE_CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = carveKey(i, j), a = carveIdx.get(k);
        if (!a) continue;
        const f = a.filter(s => s.road !== roadKey);
        if (f.length) carveIdx.set(k, f); else carveIdx.delete(k);
      }
    }
  }

  function carveAt(x, z, base) {
    const list = carveIdx.get(carveKey(Math.floor(x / CARVE_CELL), Math.floor(z / CARVE_CELL)));
    if (!list) return base;
    let h = base;
    for (let q = 0; q < list.length; q++) {
      const s = list[q];
      const t = ((x - s.ax) * s.abx + (z - s.az) * s.abz) / s.l2;
      if (t < s.lo || t > s.hi) continue;
      const tc = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (s.ax + s.abx * tc), dz = z - (s.az + s.abz * tc);
      const dd = Math.sqrt(dx * dx + dz * dz);
      if (dd > CARVE_REACH) continue;
      const y = s.ay + (s.by - s.ay) * tc - 0.12 + (dd > PIT_HALF_W ? (dd - PIT_HALF_W) * PIT_SLOPE : 0);
      if (y < h) h = y;
    }
    return h;
  }

  // wysokość końcowa terenu (z wykopami pod drogi i portale tuneli)
  function getHeight(x, z) {
    return carveAt(x, z, baseHeight(x, z));
  }

  function nearestCity(px, pz) {
    const ci = Math.floor(px / CITY_CELL), cj = Math.floor(pz / CITY_CELL);
    let best = null, bd = Infinity;
    for (let di = -3; di <= 3; di++) {
      for (let dj = -3; dj <= 3; dj++) {
        const c = getCity(ci + di, cj + dj);
        if (!c) continue;
        const d = Math.hypot(c.x - px, c.z - pz);
        if (d < bd) { bd = d; best = c; }
      }
    }
    return best ? { city: best, dist: bd } : null;
  }

  // ======================= GEOMETRIA (MeshBuilder, kolory) =======================
  // prosty budowniczy zbiorczej siatki (wszystkie budynki chunka w jednym meshu)
  class MeshBuilder {
    constructor() { this.pos = []; this.nor = []; this.col = []; this.uv = []; this.idx = []; }

    vert(x, y, z, nx, ny, nz, c, u, v) {
      this.pos.push(x, y, z);
      this.nor.push(nx, ny, nz);
      this.col.push(c.r, c.g, c.b);
      this.uv.push(u, v);
    }

    quad(p, n, color, uv) {
      const i = this.pos.length / 3;
      for (let k = 0; k < 4; k++) this.vert(p[k][0], p[k][1], p[k][2], n[0], n[1], n[2], color, uv[k][0], uv[k][1]);
      this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
    }

    // trójkąt zorientowany "na zewnątrz" względem punktu ref
    tri(a, b, c, ref, color) {
      let n = [
        (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
        (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
      ];
      const m = [
        (a[0] + b[0] + c[0]) / 3 - ref[0],
        (a[1] + b[1] + c[1]) / 3 - ref[1],
        (a[2] + b[2] + c[2]) / 3 - ref[2]
      ];
      if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < 0) { [b, c] = [c, b]; n = n.map(v => -v); }
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      n = n.map(v => v / l);
      const i = this.pos.length / 3;
      for (const p of [a, b, c]) this.vert(p[0], p[1], p[2], n[0], n[1], n[2], color, 0.08, 0.08);
      this.idx.push(i, i + 1, i + 2);
    }

    // prostopadłościan (bez spodu); ściany z teksturą okien, dach bez
    box(cx, y0, cz, w, h, d, color) {
      const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, y1 = y0 + h;
      const vh = h / WIN_H;
      const uw = w / WIN_W, ud = d / WIN_W;
      this.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], color, [[0, 0], [uw, 0], [uw, vh], [0, vh]]);
      this.quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], color, [[0, 0], [uw, 0], [uw, vh], [0, vh]]);
      this.quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], color, [[0, 0], [ud, 0], [ud, vh], [0, vh]]);
      this.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], color, [[0, 0], [ud, 0], [ud, vh], [0, vh]]);
      const t = [0.08, 0.08];
      this.quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], color, [t, t, t, t]);
    }

    // dach czterospadowy
    hip(cx, y0, cz, w, d, rh, o, color) {
      const x0 = cx - w / 2 - o, x1 = cx + w / 2 + o, z0 = cz - d / 2 - o, z1 = cz + d / 2 + o;
      const a = [x0, y0, z1], b = [x1, y0, z1], c = [x1, y0, z0], e = [x0, y0, z0];
      const ap = [cx, y0 + rh, cz], ref = [cx, y0 + rh * 0.3, cz];
      this.tri(a, b, ap, ref, color);
      this.tri(b, c, ap, ref, color);
      this.tri(c, e, ap, ref, color);
      this.tri(e, a, ap, ref, color);
    }

    // dach dwuspadowy; alongX – kalenica biegnie wzdłuż osi X
    gable(cx, y0, cz, w, d, rh, o, alongX, color) {
      const hx = w / 2 + o, hz = d / 2 + o, ref = [cx, y0 + rh * 0.3, cz];
      if (alongX) {
        this.sheet([cx - hx, y0, cz - hz], [cx + hx, y0, cz - hz], [cx + hx, y0 + rh, cz], [cx - hx, y0 + rh, cz], ref, color);
        this.sheet([cx - hx, y0, cz + hz], [cx + hx, y0, cz + hz], [cx + hx, y0 + rh, cz], [cx - hx, y0 + rh, cz], ref, color);
        this.tri([cx - hx, y0, cz - hz], [cx - hx, y0, cz + hz], [cx - hx, y0 + rh, cz], ref, color);
        this.tri([cx + hx, y0, cz - hz], [cx + hx, y0, cz + hz], [cx + hx, y0 + rh, cz], ref, color);
      } else {
        this.sheet([cx - hx, y0, cz - hz], [cx - hx, y0, cz + hz], [cx, y0 + rh, cz + hz], [cx, y0 + rh, cz - hz], ref, color);
        this.sheet([cx + hx, y0, cz - hz], [cx + hx, y0, cz + hz], [cx, y0 + rh, cz + hz], [cx, y0 + rh, cz - hz], ref, color);
        this.tri([cx - hx, y0, cz - hz], [cx + hx, y0, cz - hz], [cx, y0 + rh, cz - hz], ref, color);
        this.tri([cx - hx, y0, cz + hz], [cx + hx, y0, cz + hz], [cx, y0 + rh, cz + hz], ref, color);
      }
    }

    // walec wielokątny (wieże okrągłe, silosy); apexH > 0 → stożkowy dach; windows → ściany z teksturą okien
    prism(cx, y0, cz, r, h, seg, color, apexH, rot, windows) {
      const pts = [], y1 = y0 + h;
      for (let k = 0; k < seg; k++) { const a = (rot || 0) + k / seg * Math.PI * 2; pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); }
      const vh = windows ? h / WIN_H : 0.08;
      for (let k = 0; k < seg; k++) {
        const p = pts[k], q = pts[(k + 1) % seg];
        const uw = windows ? Math.hypot(q[0] - p[0], q[1] - p[1]) / WIN_W : 0.08;
        const mx = (p[0] + q[0]) / 2 - cx, mz = (p[1] + q[1]) / 2 - cz, l = Math.hypot(mx, mz) || 1;
        const n = [mx / l, 0, mz / l];
        let P = [[p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]]];
        let UV = [[0, 0], [uw, 0], [uw, vh], [0, vh]];
        const ax = P[1][0] - P[0][0], az = P[1][2] - P[0][2], bx = P[2][0] - P[0][0], bz = P[2][2] - P[0][2];
        if ((-az * h) * n[0] + (ax * h) * n[2] < 0) { P = [P[1], P[0], P[3], P[2]]; UV = [UV[1], UV[0], UV[3], UV[2]]; }
        this.quad(P, n, color, UV);
        if (apexH > 0) this.tri([p[0], y1, p[1]], [q[0], y1, q[1]], [cx, y1 + apexH, cz], [cx, y1 - 1, cz], color);
        else this.tri([cx, y1, cz], [p[0], y1, p[1]], [q[0], y1, q[1]], [cx, y0, cz], color);
      }
    }

    // czworokąt zorientowany "od" punktu ref (strona frontowa liczona automatycznie)
    sheet(a, b, c, d, ref, color) {
      this.tri(a, b, c, ref, color);
      this.tri(a, c, d, ref, color);
    }

    // płaski prostokąt poziomy (ulice)
    flatQuad(xa, za, xb, zb, y, color) {
      const t = [0.08, 0.08];
      this.quad([[xa, y, zb], [xb, y, zb], [xb, y, za], [xa, y, za]], [0, 1, 0], color, [t, t, t, t]);
    }

    toMesh(material) {
      if (!this.idx.length) return null;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
      geo.setIndex(new THREE.Uint32BufferAttribute(this.idx, 1));
      geo.computeBoundingSphere();
      return new THREE.Mesh(geo, material);
    }
  }

  const WIN_W = 3.0, WIN_H = 3.6;      // rozmiar jednego "kafla" okna w jednostkach świata
  const ROAD_COLOR = new THREE.Color(0x3a3d42);
  const LINE_COLOR = new THREE.Color(0xd8d2a0);
  const GRAY = new THREE.Color(0x77797d);
  const GLASS = [0x8fa6b8, 0x6f8aa0, 0xa9b9c4, 0x7d8f9c, 0x9bb0a8, 0xb3a99a];
  const CONCRETE = [0x9a9a98, 0xaaa79f, 0x8d8f93];
  const MID = [0xc9b79c, 0xb5654a, 0xd8d0c0, 0xa88f78, 0x9aa5ad];
  const HOUSE = [0xe8dcc0, 0xd9b99b, 0xc7d3d9, 0xe0c4b0, 0xb8c9a5, 0xf0e6d6];
  const ROOF = [0x8b3a2f, 0x6e4630, 0x4a5560, 0x9c5a3c];
  const pick = (arr, r) => new THREE.Color(arr[Math.floor(r() * arr.length)]).multiplyScalar(0.92 + r() * 0.16);
  const GIRDER = new THREE.Color(0x8d8f93);
  const GIRDER_DARK = new THREE.Color(0x55585c);
  const RAIL = new THREE.Color(0xb4b6b9);
  const PILLAR = new THREE.Color(0x9a9a98);
  const TUN_WALL = new THREE.Color(0x8e9094);
  const TUN_FLOOR = new THREE.Color(0x5a5c60);
  const TUN_CEIL = new THREE.Color(0x777a7f);
  const FACADE = new THREE.Color(0xa7a49c);
  const FACADE_DARK = new THREE.Color(0x6e6c68);
  const LAMP = new THREE.Color(0xfff0b8);

  // ======================= DROGI MIĘDZY MIASTAMI (z tunelami) =======================
  const roadCache = new Map();   // klucz pary miast -> { road | null, mx, mz }

  function citiesInBox(minx, minz, maxx, maxz) {
    const out = [];
    const i0 = Math.floor(minx / CITY_CELL) - 1, i1 = Math.floor(maxx / CITY_CELL) + 1;
    const j0 = Math.floor(minz / CITY_CELL) - 1, j1 = Math.floor(maxz / CITY_CELL) + 1;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const c = getCity(i, j);
        if (c) out.push(c);
      }
    }
    return out;
  }

  // koniec ulicy miejskiej zwróconej w stronę celu – tu zaczyna się droga
  function cityPort(c, tx, tz) {
    const maxR = c.r - 6;
    const half = Math.sqrt(Math.max(0, maxR * maxR - (c.P / 2) * (c.P / 2))) - 1;
    const dx = tx - c.x, dz = tz - c.z;
    const sx = dx >= 0 ? 1 : -1, sz = dz >= 0 ? 1 : -1;
    return Math.abs(dx) >= Math.abs(dz)
      ? { x: c.x + sx * half, z: c.z + sz * c.P / 2 }
      : { x: c.x + sx * c.P / 2, z: c.z + sz * half };
  }

  // trasa S -> E: prosta + wybrzuszenie (bulge) + lekkie wijące się odchylenia z szumu Perlina
  function tracePath(S, E, len, bulge, wig, noff) {
    const n = Math.max(2, Math.ceil(len / ROAD_STEP));
    const dx = (E.x - S.x) / len, dz = (E.z - S.z) / len;
    const px = -dz, pz = dx;
    const pts = new Array(n + 1);
    for (let i = 0; i <= n; i++) {
      const t = i / n, s = t * len;
      const sn = Math.sin(Math.PI * t), env = sn * sn;   // zero na końcach – gładkie wejście w miasto
      const lat = env * (bulge + wig * perlin.noise(s * 0.008, noff));
      pts[i] = { x: S.x + dx * s + px * lat, z: S.z + dz * s + pz * lat, h: 0 };
    }
    return pts;
  }

  // Profil pionowy drogi. Niweleta to najwyższa funkcja o nachyleniu <= ROAD_GRADE leżąca pod terenem:
  // na łagodnym terenie droga biegnie po powierzchni, a przez wysokie grzbiety "przebija się" pod nimi
  // (wykop, a gdy nad drogą jest dość gruntu – tunel). Droga nigdy nie wisi nad terenem.
  function designProfile(pts) {
    const n = pts.length;
    const h = new Float32Array(n), he = new Float32Array(n), sm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      p.h = baseHeight(p.x, p.z);
      h[i] = p.h;
      he[i] = Math.max(p.h, WATER_LEVEL + 1.1);   // nad wodą droga biegnie mostem
    }
    const K = 4;
    for (let i = 0; i < n; i++) {
      let a = 0;
      for (let j = i - K; j <= i + K; j++) a += he[j < 0 ? 0 : j >= n ? n - 1 : j];
      sm[i] = a / (2 * K + 1);
    }
    const g = ROAD_GRADE * ROAD_STEP;
    const env = Float32Array.from(sm);
    for (let i = 1; i < n; i++) env[i] = Math.min(env[i], env[i - 1] + g);
    for (let i = n - 2; i >= 0; i--) env[i] = Math.min(env[i], env[i + 1] + g);

    const y = new Float32Array(n), d = new Float32Array(n), dT = new Float32Array(n);
    let climb = 0, nCarve = 0;
    for (let i = 0; i < n; i++) {
      const edge = Math.min(i, n - 1 - i);
      let yy = Math.min(env[i], he[i]);
      yy = lerp(he[i], yy, smooth01(4, 14, edge));          // przy miastach droga trzyma poziom terenu
      if (h[i] - yy < TUN_EDGE) yy = he[i];                  // płytkich wykopów nie robimy
      y[i] = yy;
    }
    // reguła „płytki wykop = jedź po terenie” mogła złamać limit nachylenia (np. na stromym brzegu) – wymuszamy go ponownie;
    // przejścia tylko obniżają niweletę, więc droga nadal nie wisi nad terenem
    for (let i = 1; i < n; i++) y[i] = Math.min(y[i], y[i - 1] + g);
    for (let i = n - 2; i >= 0; i--) y[i] = Math.min(y[i], y[i + 1] + g);
    for (let i = 0; i < n; i++) {
      const yy = y[i];
      d[i] = h[i] - yy;
      dT[i] = d[i];
      if (d[i] > TUN_COVER * 0.8) {   // pod zboczem prawa/lewa strona terenu bywa niższa niż oś – liczy się najniższa
        const p0 = pts[i > 0 ? i - 1 : 0], p1 = pts[i < n - 1 ? i + 1 : n - 1];
        let tx = p1.x - p0.x, tz = p1.z - p0.z;
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        const hl = baseHeight(pts[i].x - tz * 5, pts[i].z + tx * 5), hr = baseHeight(pts[i].x + tz * 5, pts[i].z - tx * 5);
        dT[i] = Math.min(h[i], hl, hr) - yy;
      }
      if (i) climb += Math.abs(y[i] - y[i - 1]);
    }

    // tunele: ciągi próbek z gruntem > TUN_COVER nad jezdnią, w których wykop byłby głębszy niż TUN_CORE
    const tun = new Uint8Array(n);
    let nTun = 0;
    for (let i = 0; i < n;) {
      if (dT[i] <= TUN_COVER || i < 6 || i > n - 7) { i++; continue; }
      let j = i, mx = 0;
      while (j < n - 6 && dT[j + 1] > TUN_COVER) { j++; }
      for (let k = i; k <= j; k++) mx = Math.max(mx, dT[k]);
      if (mx > TUN_CORE && j - i >= 3) { for (let k = i; k <= j; k++) { tun[k] = 1; nTun++; } }
      i = j + 1;
    }
    for (let i = 0; i < n; i++) if (!tun[i] && d[i] > TUN_EDGE) nCarve++;
    return { y, d, tun, nTun, nCarve, climb };
  }

  // koszt trasy: woda, wspinaczka, tunele, wykopy i przejazd przez cudze miasto (kara dyskwalifikująca)
  function evalPath(pts, others) {
    const prof = designProfile(pts);
    let water = 0, run = 0, maxRun = 0, hit = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.h < WATER_LEVEL + 0.75) { water++; run++; if (run > maxRun) maxRun = run; } else run = 0;
      for (const c of others) {
        const dx = p.x - c.x, dz = p.z - c.z, rr = c.r + 10;
        if (dx * dx + dz * dz < rr * rr) { hit = 1; break; }
      }
    }
    const cost = water * 6 + prof.climb * 0.6 + prof.nTun * 2.2 + prof.nCarve * 0.9 + hit * 1e5;
    return { cost, water, maxRun, hit, prof };
  }

  function buildRoad(a, b, key) {
    const S = cityPort(a, b.x, b.z), E = cityPort(b, a.x, a.z);
    const len = Math.hypot(E.x - S.x, E.z - S.z);
    if (len < 40) return null;

    const others = citiesInBox(
      Math.min(S.x, E.x) - 200, Math.min(S.z, E.z) - 200,
      Math.max(S.x, E.x) + 200, Math.max(S.z, E.z) + 200
    ).filter(c => c.id !== a.id && c.id !== b.id);

    // kilka wariantów trasy – wybieramy ten o najmniejszym koszcie (woda, wspinaczka, tunele)
    const noff = (hash2(a.ci * 31 + b.ci, a.cj * 17 + b.cj) % 1000) / 9;
    let best = null;
    for (const m of [0, 0.07, -0.07, 0.14, -0.14]) {
      const pts = tracePath(S, E, len, m * len, Math.min(40, len * 0.03), noff);
      const ev = evalPath(pts, others);
      if (!best || ev.cost < best.ev.cost) best = { pts, ev };
    }
    const { pts, ev } = best;
    const n = pts.length - 1;
    if (ev.hit || ev.water > 0.45 * pts.length || ev.maxRun * ROAD_STEP > 240) return null;
    const prof = ev.prof;

    // próbki: oś + lewa/prawa krawędź. W wykopie i w tunelu jezdnia jest płaska w poprzek.
    const s = new Array(n + 1);
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (let i = 0; i <= n; i++) {
      const p = pts[i], p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(n, i + 1)];
      let tx = p1.x - p0.x, tz = p1.z - p0.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const px = -tz, pz = tx;
      const lx = p.x + px * ROAD_HW, lz = p.z + pz * ROAD_HW;
      const rx = p.x - px * ROAD_HW, rz = p.z - pz * ROAD_HW;
      const lift = 0.1 + 0.15 * Math.min(1, Math.min(i, n - i) * ROAD_STEP / 20);  // przy mieście równo z ulicą
      const floor = WATER_LEVEL + 0.15;
      const yc = prof.y[i] + lift;
      const tn = prof.tun[i] === 1;
      const br = p.h < WATER_LEVEL + 0.75;
      const hL = Math.max(baseHeight(lx, lz) + lift, floor), hR = Math.max(baseHeight(rx, rz) + lift, floor);
      // zbocze wyższe od jezdni o więcej niż XSLOPE_TOL → wykop (teren obniżany do poziomu drogi, jezdnia pozioma w poprzek)
      const cv = !tn && !br && (prof.d[i] > TUN_EDGE || hL - yc > XSLOPE_TOL || hR - yc > XSLOPE_TOL);
      const flat = tn || cv || br;
      s[i] = {
        x: p.x, z: p.z, px, pz, lx, lz, rx, rz,
        yc,
        yl: flat ? yc : clamp(hL, yc - XSLOPE_TOL, yc + XSLOPE_TOL),   // przechył poprzeczny jest ograniczony
        yr: flat ? yc : clamp(hR, yc - XSLOPE_TOL, yc + XSLOPE_TOL),
        br, tun: tn ? 1 : 0, cut: cv ? 1 : 0, d: prof.d[i]
      };
      if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
      if (p.z < minz) minz = p.z; if (p.z > maxz) maxz = p.z;
    }

    // portale: wejście (wzrost indeksu prowadzi w głąb góry) i wyjście
    const portals = [];
    for (let i = 0; i < n; i++) {
      if (!s[i].tun && s[i + 1].tun) portals.push({ i, dir: 1 });
      else if (s[i].tun && !s[i + 1].tun) portals.push({ i: i + 1, dir: -1 });
    }

    // wykopy: teren obniżany do poziomu jezdni; portal to twardy koniec wykopu
    const isTunSeg = k => k >= 0 && k < n && (s[k].tun || s[k + 1].tun);
    for (let i = 0; i < n; i++) {
      if (isTunSeg(i) || !(s[i].cut || s[i + 1].cut)) continue;
      addCarveSeg({
        ax: s[i].x, az: s[i].z, ay: s[i].yc, bx: s[i + 1].x, bz: s[i + 1].z, by: s[i + 1].yc,
        lo: isTunSeg(i - 1) ? 0 : -Infinity, hi: isTunSeg(i + 1) ? 1 : Infinity, road: key
      });
    }

    const m = ROAD_HW + 10;
    return {
      key, s, portals, nTun: prof.nTun, len,
      minx: minx - m, maxx: maxx + m, minz: minz - m, maxz: maxz + m,
      cellBox: { minx: minx - CARVE_REACH, maxx: maxx + CARVE_REACH, minz: minz - CARVE_REACH, maxz: maxz + CARVE_REACH }
    };
  }

  function getRoad(a, b) {
    if (a.id > b.id) { const t = a; a = b; b = t; }   // para zawsze w tej samej kolejności
    const key = a.id + '|' + b.id;
    let e = roadCache.get(key);
    if (!e) {
      e = { road: buildRoad(a, b, key), mx: (a.x + b.x) / 2, mz: (a.z + b.z) / 2 };
      roadCache.set(key, e);
    }
    return e.road;
  }

  // każde miasto łączy się z kilkoma najbliższymi (do których da się zbudować drogę)
  function getCityLinks(city) {
    if (city.links) return city.links;
    const cands = [];
    for (let di = -3; di <= 3; di++) {
      for (let dj = -3; dj <= 3; dj++) {
        if (!di && !dj) continue;
        const o = getCity(city.ci + di, city.cj + dj);
        if (!o) continue;
        const d = Math.hypot(o.x - city.x, o.z - city.z);
        if (d <= MAX_ROAD_DIST) cands.push([d, o]);
      }
    }
    cands.sort((p, q) => p[0] - q[0]);
    const links = [];
    for (const [, o] of cands) {
      if (links.length >= ROAD_LINKS) break;
      if (getRoad(city, o)) links.push(o);
    }
    city.links = links;
    return links;
  }

  // drogi, których obwiednia dotyka tego chunka (przy okazji buduje wszystkie drogi w okolicy,
  // więc wykopy są zarejestrowane, zanim policzymy wysokości terenu)
  function getChunkRoads(x0, z0) {
    const ci = Math.floor(x0 / CITY_CELL), cj = Math.floor(z0 / CITY_CELL);
    const found = new Map();
    for (let di = -4; di <= 4; di++) {
      for (let dj = -4; dj <= 4; dj++) {
        const c = getCity(ci + di, cj + dj);
        if (!c) continue;
        for (const o of getCityLinks(c)) {
          const road = getRoad(c, o);
          if (!road || found.has(road.key)) continue;
          if (road.maxx < x0 || road.minx > x0 + CHUNK || road.maxz < z0 || road.minz > z0 + CHUNK) continue;
          found.set(road.key, road);
        }
      }
    }
    return [...found.values()];
  }

  // ---------- wnętrze tunelu i portale ----------
  const ARCH_N = 8;
  // przekrój wnętrza: punkty (u = w lewo od osi, h = nad jezdnią): ściana, łuk sklepienia, ściana
  const TUN_RING = (() => {
    const r = [[TUN_HALF_W, 0]];
    for (let k = 0; k <= ARCH_N; k++) {
      const th = Math.PI * k / ARCH_N;
      r.push([TUN_HALF_W * Math.cos(th), TUN_WALL_H + TUN_ARCH_H * Math.sin(th)]);
    }
    r.push([-TUN_HALF_W, 0]);
    return r;
  })();

  // punkt w układzie próbki drogi: u w lewo, h w górę
  const framePt = (s, u, h) => [s.x + s.px * u, s.yc + h, s.z + s.pz * u];

  // ---- „kaptur” portalu: pierwsze metry tunelu, gdzie zbocze jeszcze nie przykrywa sklepienia ----
  const HOOD_LEN = 14;
  const HOOD_DIRT = new THREE.Color(0x6e6858);

  // indeksy odcinków drogi należące do kaptura (przy portalach)
  function hoodSet(road) {
    if (road.hood) return road.hood;
    const set = new Set(), n = Math.ceil(HOOD_LEN / ROAD_STEP) + 1;
    for (const pt of road.portals) {
      for (let q = 0; q < n; q++) set.add(pt.dir > 0 ? pt.i + q : pt.i - 1 - q);
    }
    road.hood = set;
    return set;
  }

  // strefy portali dotykające chunka: teren w ich obrysie nie może wchodzić do wnętrza tunelu
  function portalZones(roads, x0, z0) {
    const out = [], m = HOOD_LEN + 6;
    for (const road of roads) {
      for (const pt of road.portals) {
        const ps = road.s[pt.i];
        if (ps.x < x0 - m || ps.x > x0 + CHUNK + m || ps.z < z0 - m || ps.z > z0 + CHUNK + m) continue;
        out.push({ x: ps.x, z: ps.z, tx: ps.pz * pt.dir, tz: -ps.px * pt.dir, px: ps.px, pz: ps.pz, top: ps.yc + TUN_H + 0.25 });
      }
    }
    return out;
  }

  // czy trójkąt terenu (środek cx,cz; najniższy wierzchołek hmin) wcina się w kaptur portalu
  function inHood(zones, cx, cz, hmin) {
    for (let q = 0; q < zones.length; q++) {
      const zn = zones[q];
      if (hmin >= zn.top) continue;
      const dx = cx - zn.x, dz = cz - zn.z;
      const d = dx * zn.tx + dz * zn.tz;
      if (d < 0.2 || d > HOOD_LEN - 4) continue;
      const u = dx * zn.px + dz * zn.pz;
      if (u > -(TUN_HALF_W - 0.2) && u < TUN_HALF_W - 0.2) return true;
    }
    return false;
  }

  function addTunnelSegment(tb, lb, a, b, idx, hood) {
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, px: a.px, pz: a.pz, yc: (a.yc + b.yc) / 2 };
    const last = TUN_RING.length - 2;
    if (hood) {
      // zewnętrzna betonowa osłona (teren w tym miejscu nie przykrywa sklepienia) + utwardzone pobocza
      const inner = framePt(mid, 0, TUN_WALL_H * 0.6);
      for (let m = 0; m <= last; m++) {
        const u0 = TUN_RING[m][0], h0 = TUN_RING[m][1], u1 = TUN_RING[m + 1][0], h1 = TUN_RING[m + 1][1];
        tb.sheet(framePt(a, u0, h0), framePt(b, u0, h0), framePt(b, u1, h1), framePt(a, u1, h1), inner, FACADE);
      }
      for (const sg of [1, -1]) {
        const u0 = sg * TUN_HALF_W, u1 = sg * (TUN_HALF_W + 3.5);
        tb.sheet(framePt(a, u0, -0.1), framePt(b, u0, -0.1), framePt(b, u1, -0.1), framePt(a, u1, -0.1),
          framePt(mid, 0, -6), HOOD_DIRT);
      }
    }
    for (let m = 0; m <= last; m++) {
      const u0 = TUN_RING[m][0], h0 = TUN_RING[m][1], u1 = TUN_RING[m + 1][0], h1 = TUN_RING[m + 1][1];
      const um = (u0 + u1) / 2, hm = (h0 + h1) / 2;
      const ref = framePt(mid, um * 3, TUN_WALL_H + (hm - TUN_WALL_H) * 3);   // punkt poza powłoką
      tb.sheet(framePt(a, u0, h0), framePt(b, u0, h0), framePt(b, u1, h1), framePt(a, u1, h1), ref,
        (m === 0 || m === last) ? TUN_WALL : TUN_CEIL);
    }
    // pobocza (beton po obu stronach jezdni)
    for (const sg of [1, -1]) {
      const u0 = sg * ROAD_HW, u1 = sg * TUN_HALF_W;
      tb.sheet(framePt(a, u0, -0.03), framePt(b, u0, -0.03), framePt(b, u1, -0.03), framePt(a, u1, -0.03),
        framePt(mid, 0, -6), TUN_FLOOR);
    }
    // oświetlenie: listwa pod sklepieniem co 3. odcinek i pasy świetlne na ścianach
    if (idx % 3 === 0) {
      const ht = TUN_H - 0.04;
      lb.sheet(framePt(a, -0.55, ht), framePt(b, -0.55, ht), framePt(b, 0.55, ht), framePt(a, 0.55, ht),
        framePt(mid, 0, TUN_H + 6), LAMP);
    }
    if (idx % 2 === 0) {
      for (const sg of [1, -1]) {
        const u = sg * (TUN_HALF_W - 0.03);
        lb.sheet(framePt(a, u, 2.05), framePt(b, u, 2.05), framePt(b, u, 2.3), framePt(a, u, 2.3),
          framePt(mid, sg * 9, 2.2), LAMP);
      }
    }
  }

  // betonowa ściana portalu z otworem w kształcie wnętrza; dir = +1, gdy tunel biegnie w stronę rosnącego indeksu
  function addFacade(fb, s, dir) {
    const tx = s.pz * dir, tz = -s.px * dir;               // kierunek w głąb góry
    const ref = [s.x + tx * 10, s.yc + 3, s.z + tz * 10];  // punkt wewnątrz góry – ściana patrzy od niego
    const Ht = TUN_COVER + 0.7, Hb = -1.6, F = FACADE_HALF_W;
    const P = (u, h, off) => [s.x + s.px * u - tx * (off || 0), s.yc + h, s.z + s.pz * u - tz * (off || 0)];
    for (const sg of [1, -1]) {
      fb.sheet(P(sg * TUN_HALF_W, Hb), P(sg * F, Hb), P(sg * F, Ht), P(sg * TUN_HALF_W, Ht), ref, FACADE);
    }
    for (let k = 0; k < ARCH_N; k++) {
      const t0 = Math.PI * k / ARCH_N, t1 = Math.PI * (k + 1) / ARCH_N;
      const u0 = TUN_HALF_W * Math.cos(t0), u1 = TUN_HALF_W * Math.cos(t1);
      const h0 = TUN_WALL_H + TUN_ARCH_H * Math.sin(t0), h1 = TUN_WALL_H + TUN_ARCH_H * Math.sin(t1);
      fb.sheet(P(u0, h0), P(u1, h1), P(u1, Ht), P(u0, Ht), ref, FACADE);
      // ciemna obwódka otworu, lekko wysunięta przed ścianę
      fb.sheet(P(u0, h0, 0.05), P(u1, h1, 0.05),
        P(TUN_HALF_W * 1.12 * Math.cos(t1), TUN_WALL_H + (TUN_ARCH_H + 0.5) * Math.sin(t1), 0.05),
        P(TUN_HALF_W * 1.12 * Math.cos(t0), TUN_WALL_H + (TUN_ARCH_H + 0.5) * Math.sin(t0), 0.05), ref, FACADE_DARK);
    }
    // słupki obwódki po bokach otworu
    for (const sg of [1, -1]) {
      fb.sheet(P(sg * TUN_HALF_W, 0, 0.05), P(sg * TUN_HALF_W * 1.12, 0, 0.05),
        P(sg * TUN_HALF_W * 1.12, TUN_WALL_H, 0.05), P(sg * TUN_HALF_W, TUN_WALL_H, 0.05), ref, FACADE_DARK);
    }
  }

  // ======================= SIATKA DRÓG, MOSTÓW I TUNELI (per chunk) =======================
  // Odcinek drogi należy do chunka, w którym leży jego środek; portal – do chunka swojej próbki.
  function buildRoads(group, roads, x0, z0) {
    const x1 = x0 + CHUNK, z1 = z0 + CHUNK;
    const rb = new MeshBuilder(), bb = new MeshBuilder(), tb = new MeshBuilder(), lb = new MeshBuilder(), fb = new MeshBuilder();
    const segs = [];
    const T = 1.1, RH = 0.9;

    for (const road of roads) {
      const s = road.s;
      for (let i = 0; i < s.length - 1; i++) {
        const a = s[i], b = s[i + 1];
        const mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
        if (mx < x0 || mx >= x1 || mz < z0 || mz >= z1) continue;

        const AL = [a.lx, a.yl, a.lz], AC = [a.x, a.yc, a.z], AR = [a.rx, a.yr, a.rz];
        const BL = [b.lx, b.yl, b.lz], BC = [b.x, b.yc, b.z], BR = [b.rx, b.yr, b.rz];
        const my = (a.yc + b.yc) * 0.5;
        const below = [mx, my - 8, mz];
        const isTun = a.tun || b.tun;
        segs.push({
          ax: a.x, az: a.z, bx: b.x, bz: b.z, px: a.px, pz: a.pz,
          ay: a.yc, by: b.yc, ayl: a.yl, byl: b.yl, ayr: a.yr, byr: b.yr,
          br: a.br || b.br, tun: isTun ? 1 : 0
        });
        rb.sheet(AL, BL, BC, AC, below, ROAD_COLOR);
        rb.sheet(AC, BC, BR, AR, below, ROAD_COLOR);

        if (i % 4 < 2) {   // przerywana linia środkowa
          const w = 0.15, y = 0.14;
          rb.sheet(
            [a.x + a.px * w, a.yc + y, a.z + a.pz * w], [b.x + b.px * w, b.yc + y, b.z + b.pz * w],
            [b.x - b.px * w, b.yc + y, b.z - b.pz * w], [a.x - a.px * w, a.yc + y, a.z - a.pz * w],
            below, LINE_COLOR
          );
        }

        if (isTun) addTunnelSegment(tb, lb, a, b, i, hoodSet(road).has(i));

        // mur oporowy: jezdnia na nasypie nad niżej położonym zboczem
        if (!isTun && !a.br && !b.br) {
          for (const side of [1, -1]) {
            const P1 = side > 0 ? AL : AR, P2 = side > 0 ? BL : BR;
            const g1 = getHeight(P1[0] + side * a.px * 0.6, P1[2] + side * a.pz * 0.6) - 0.5;
            const g2 = getHeight(P2[0] + side * b.px * 0.6, P2[2] + side * b.pz * 0.6) - 0.5;
            if (P1[1] - g1 > 0.5 || P2[1] - g2 > 0.5) {
              const Q1 = [P1[0], Math.min(g1, P1[1] - 0.3), P1[2]], Q2 = [P2[0], Math.min(g2, P2[1] - 0.3), P2[2]];
              if (P1[1] - Q1[1] < 16 && P2[1] - Q2[1] < 16) {
                bb.sheet(P1, P2, Q2, Q1, [mx + side * a.px * 8, my, mz + side * a.pz * 8], PILLAR);
              }
            }
          }
        }

        if (a.br || b.br) {
          const mid = [mx, my, mz];
          const AL2 = [a.lx, a.yl - T, a.lz], BL2 = [b.lx, b.yl - T, b.lz];
          const AR2 = [a.rx, a.yr - T, a.rz], BR2 = [b.rx, b.yr - T, b.rz];
          bb.sheet(AL, BL, BL2, AL2, mid, GIRDER);                       // burta lewa
          bb.sheet(AR, BR, BR2, AR2, mid, GIRDER);                       // burta prawa
          bb.sheet(AL2, BL2, BR2, AR2, [mx, my + 8, mz], GIRDER_DARK);   // spód pokładu

          // barierki (obie strony ścianki, żeby było je widać z każdej strony)
          for (const side of [1, -1]) {
            const P1 = side > 0 ? AL : AR, P2 = side > 0 ? BL : BR;
            const T1 = [P1[0], P1[1] + RH, P1[2]], T2 = [P2[0], P2[1] + RH, P2[2]];
            const outside = [mx + side * a.px * 8, my, mz + side * a.pz * 8];
            bb.sheet(P1, P2, T2, T1, mid, RAIL);
            bb.sheet(P1, P2, T2, T1, outside, RAIL);
          }

          // filary co kilka próbek
          if (a.br && i % 5 === 0) {
            const bottom = getHeight(a.x, a.z) - 0.6, top = a.yc - T;
            if (top - bottom > 0.5) bb.box(a.x, bottom, a.z, 1.8, top - bottom, 1.8, PILLAR);
          }
        }
      }
      for (const pt of road.portals) {
        const ps = s[pt.i];
        if (ps.x >= x0 && ps.x < x1 && ps.z >= z0 && ps.z < z1) addFacade(fb, ps, pt.dir);
      }
    }

    const add = (builder, mat) => { const m = builder.toMesh(mat); if (m) group.add(m); };
    add(rb, roadMat);
    add(bb, plainMat);
    add(tb, plainMat);
    add(fb, plainMat);
    add(lb, lampMat);
    if (segs.length) roadSegs.set(group.userData.key, segs);
  }

  // ======================= SCENA (renderer, niebo, światło, materiały) =======================
  const canvas = document.getElementById('game');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  function applyRenderScale() {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * clamp(settings.renderScale, 0.5, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  applyRenderScale();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9ec9e8);
  scene.fog = new THREE.Fog(0x9ec9e8, 100, 500);

  const camera = new THREE.PerspectiveCamera(settings.fov, window.innerWidth / window.innerHeight, 0.3, 1500);
  camera.rotation.order = 'YXZ';

  const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x556b3a, 0.75);
  const sun = new THREE.DirectionalLight(0xfff2d6, 0.9);
  scene.add(hemi);
  scene.add(sun);

  // woda – płaszczyzna podążająca za graczem (rozmiar skalowany do zasięgu widzenia)
  const waterMat = new THREE.MeshPhongMaterial({
    color: 0x2e7fb8, transparent: true, opacity: 0.72, shininess: 90, specular: 0x99ccee
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_LEVEL;
  scene.add(water);

  // zasięg widzenia → mgła, płaszczyzna kamery, rozmiar wody
  function applyViewDistance() {
    const far = viewDist() * CHUNK;
    scene.fog.near = far * 0.5;
    scene.fog.far = far * 1.02;
    camera.far = far * 1.4;
    camera.updateProjectionMatrix();
    water.scale.set(far * 3, far * 3, 1);
  }
  applyViewDistance();

  // ---- pora dnia ----
  let nightFactor = 0;   // 0 = dzień, 1 = noc (używane przez reflektory auta)
  const SKY_DAY = [0.62, 0.79, 0.91], SKY_NIGHT = [0.02, 0.035, 0.08], SKY_DUSK = [0.95, 0.55, 0.32];
  function applyTimeOfDay(hour) {
    const a = ((hour - 6) / 12) * Math.PI;     // 6:00 wschód, 12:00 zenit, 18:00 zachód
    const elev = Math.sin(a);
    const dayF = smooth01(-0.12, 0.3, elev);
    const tw = clamp(1 - Math.abs(elev) / 0.32, 0, 1) * 0.7;
    const col = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const base = lerp(SKY_NIGHT[k], SKY_DAY[k], dayF);
      col[k] = lerp(base, SKY_DUSK[k], tw);
    }
    scene.background.setRGB(col[0], col[1], col[2]);
    scene.fog.color.setRGB(col[0], col[1], col[2]);
    nightFactor = 1 - dayF;
    hemi.intensity = 0.16 + 0.62 * dayF;
    if (elev >= 0) {
      sun.position.set(Math.cos(a) * 0.9, Math.max(elev, 0.05) + 0.1, 0.35);
      sun.intensity = 0.15 + 0.85 * smooth01(0, 0.3, elev);
      sun.color.setRGB(1, lerp(0.62, 0.95, smooth01(0, 0.5, elev)), lerp(0.4, 0.84, smooth01(0, 0.5, elev)));
    } else {
      sun.position.set(-Math.cos(a) * 0.6, -elev + 0.2, -0.3);   // „księżyc” po przeciwnej stronie
      sun.intensity = 0.2 * smooth01(0, 0.4, -elev) + 0.05;
      sun.color.setRGB(0.55, 0.65, 1);
    }
  }
  applyTimeOfDay(settings.timeOfDay);

  // ---- materiały i geometrie współdzielone ----
  const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });

  // tekstura okien (biała ściana + ciemne okno); mnoży się z kolorem wierzchołków
  function makeWindowTexture() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 128, 128);
    const grad = g.createLinearGradient(0, 22, 0, 106);
    grad.addColorStop(0, '#34506f');
    grad.addColorStop(1, '#1b2838');
    g.fillStyle = grad;
    g.fillRect(24, 22, 80, 84);
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.beginPath(); g.moveTo(24, 22); g.lineTo(70, 22); g.lineTo(24, 70); g.closePath(); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(63, 22, 2, 84);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }
  const buildingMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: makeWindowTexture() });
  const roadMat = new THREE.MeshLambertMaterial({
    vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  });
  const plainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const lampMat = new THREE.MeshBasicMaterial({ vertexColors: true });   // lampy tunelowe świecą zawsze

  // kolor terenu: trawa → skała (stromo / wysoko) → śnieg (bardzo wysoko), piasek przy wodzie
  const SNOW_LINE = 250, ROCK_LINE = 150;
  function terrainColor(h, slope, x, z, out) {
    const n = perlin.noise(x * 0.25, z * 0.25) * 0.06;
    const sn = perlin.noise(x * 0.01 + 7, z * 0.01 + 7) * 40;
    const t = clamp((h - 2) / 150, 0, 1);
    let r = 0.27 + t * 0.10 + n, g = 0.58 - t * 0.20 + n, b = 0.20 + t * 0.04 + n;     // trawa
    const rock = Math.max(smooth01(0.38, 0.62, slope), smooth01(ROCK_LINE + sn * 0.5, ROCK_LINE + 50 + sn * 0.5, h));
    const rk = 0.42 + n * 1.2;
    r = lerp(r, rk, rock); g = lerp(g, rk * 0.97, rock); b = lerp(b, rk * 0.92, rock);
    const snow = smooth01(SNOW_LINE + sn, SNOW_LINE + 40 + sn, h) * (1 - smooth01(0.62, 0.95, slope) * 0.8);
    r = lerp(r, 0.95, snow); g = lerp(g, 0.96, snow); b = lerp(b, 0.98, snow);
    const sand = (1 - smooth01(WATER_LEVEL + 0.8, WATER_LEVEL + 2.4, h)) * (1 - rock);
    r = lerp(r, 0.80 + n, sand); g = lerp(g, 0.73 + n, sand); b = lerp(b, 0.50 + n, sand);
    out[0] = r; out[1] = g; out[2] = b;
  }

  // ======================= FLORA: drzewa (6 gatunków), krzewy, głazy i formacje skalne =======================
  // Każdy gatunek to niskopoligonowa siatka z kolorami wierzchołków (płaskie cieniowanie). Geometrie powstają raz;
  // chunki rysują je instancjami z indywidualnym odcieniem (jesienne liście, odmiany zieleni, skały mokre/ośnieżone).
  const hexC = (h, k) => { k = k || 1; return { r: ((h >> 16) & 255) / 255 * k, g: ((h >> 8) & 255) / 255 * k, b: (h & 255) / 255 * k }; };
  const mixC = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
  const shadeC = (c, k) => ({ r: c.r * k, g: c.g * k, b: c.b * k });

  // gałąź/pień: ścięty wielokąt między dwoma punktami
  function fLimb(mb, ax, ay, az, bx, by, bz, r0, r1, seg, col, col2) {
    const ra = [], rb = [];
    for (let k = 0; k < seg; k++) {
      const a = k / seg * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      ra.push([ax + c * r0, ay, az + s * r0]);
      rb.push([bx + c * r1, by, bz + s * r1]);
    }
    const ref = [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2];
    for (let k = 0; k < seg; k++) {
      const k2 = (k + 1) % seg;
      mb.sheet(ra[k], ra[k2], rb[k2], rb[k], ref, k % 2 ? shadeC(col2 || col, 1) : col);
    }
  }

  // stożek warstwy świerka
  function fCone(mb, ox, oy, oz, r, h, seg, col, rnd, cap) {
    const ring = [];
    for (let k = 0; k < seg; k++) {
      const a = k / seg * Math.PI * 2, rr = r * (0.88 + rnd() * 0.24);
      ring.push([ox + Math.cos(a) * rr, oy + (rnd() - 0.5) * 0.12, oz + Math.sin(a) * rr]);
    }
    const apex = [ox + (rnd() - 0.5) * 0.15, oy + h, oz + (rnd() - 0.5) * 0.15], ref = [ox, oy + h * 0.35, oz];
    for (let k = 0; k < seg; k++) {
      const f = 0.92 + rnd() * 0.16;
      mb.tri(ring[k], ring[(k + 1) % seg], apex, ref, shadeC(col, f));
      if (cap) mb.tri([ox, oy, oz], ring[k], ring[(k + 1) % seg], [ox, oy + h, oz], shadeC(col, 0.6));
    }
  }

  // bryła z siatki ikosfery (poziom 0 = 20 ścian, 1 = 80), z zaburzeniem promienia; dół ciemniejszy, góra jaśniejsza
  const ICO_T = (1 + Math.sqrt(5)) / 2;
  const ICO_V = [[-1, ICO_T, 0], [1, ICO_T, 0], [-1, -ICO_T, 0], [1, -ICO_T, 0], [0, -1, ICO_T], [0, 1, ICO_T], [0, -1, -ICO_T], [0, 1, -ICO_T], [ICO_T, 0, -1], [ICO_T, 0, 1], [-ICO_T, 0, -1], [-ICO_T, 0, 1]]
    .map(v => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; });
  const ICO_F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  function icoFaces(level) {
    let faces = ICO_F.map(f => f.map(i => ICO_V[i]));
    for (let l = 0; l < level; l++) {
      const out = [];
      const mid = (a, b) => { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], q = Math.hypot(m[0], m[1], m[2]); return [m[0] / q, m[1] / q, m[2] / q]; };
      for (const [a, b, c] of faces) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); out.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
      faces = out;
    }
    return faces;
  }
  const ICO_CACHE = [icoFaces(0), icoFaces(1)];

  function fBlob(mb, ox, oy, oz, rx, ry, rz, level, colTop, colBot, rnd, jit, floorY) {
    const faces = ICO_CACHE[level], jmap = new Map();
    const jr = u => {
      const key = Math.round(u[0] * 500) + ',' + Math.round(u[1] * 500) + ',' + Math.round(u[2] * 500);
      let j = jmap.get(key);
      if (j === undefined) { j = 1 + (rnd() - 0.5) * 2 * jit; jmap.set(key, j); }
      return j;
    };
    const place = u => {
      const j = jr(u);
      let y = u[1] * ry * j;
      if (floorY !== undefined && y < floorY * ry) y = floorY * ry;
      return [ox + u[0] * rx * j, oy + y, oz + u[2] * rz * j];
    };
    for (const f of faces) {
      const cy = (f[0][1] + f[1][1] + f[2][1]) / 3;
      const c = shadeC(mixC(colBot, colTop, clamp(0.5 + cy * 0.65, 0, 1)), 0.92 + rnd() * 0.16);
      mb.tri(place(f[0]), place(f[1]), place(f[2]), [ox, oy, oz], c);
    }
  }

  // ---------- gatunki drzew (podstawa w y=oy, wysokość ok. 8-10 m przy s=1) ----------
  function treeSpruce(mb, ox, oy, oz, s, rnd) {
    fLimb(mb, ox, oy - 0.2 * s, oz, ox, oy + 2.4 * s, oz, 0.3 * s, 0.14 * s, 6, hexC(0x5a3d26), hexC(0x4b321f));
    const base = hexC(0x23592f);
    for (let i = 0; i < 5; i++) {
      const y = oy + (0.9 + i * 1.5) * s, r = (2.2 - i * 0.42) * s, h = (2.7 - i * 0.12) * s;
      fCone(mb, ox, y, oz, r, h, 8, shadeC(mixC(base, hexC(0x3f7d3f), i / 6), 0.82 + 0.05 * i), rnd, i === 0);
    }
  }
  function treePine(mb, ox, oy, oz, s, rnd) {
    fLimb(mb, ox, oy - 0.2 * s, oz, ox + 0.2 * s, oy + 6.6 * s, oz, 0.32 * s, 0.15 * s, 6, hexC(0x8a5a34), hexC(0x6e4527));
    const t = hexC(0x4e8248), b = hexC(0x2c5a34);
    fBlob(mb, ox + 0.2 * s, oy + 6.6 * s, oz, 2.0 * s, 1.1 * s, 2.0 * s, 0, t, b, rnd, 0.22, -0.6);
    fBlob(mb, ox + 1.1 * s, oy + 5.6 * s, oz + 0.5 * s, 1.35 * s, 0.8 * s, 1.35 * s, 0, t, b, rnd, 0.22, -0.6);
    fBlob(mb, ox - 0.9 * s, oy + 7.3 * s, oz - 0.6 * s, 1.35 * s, 0.85 * s, 1.35 * s, 0, t, b, rnd, 0.22, -0.6);
  }
  function treeOak(mb, ox, oy, oz, s, rnd) {
    fLimb(mb, ox, oy - 0.2 * s, oz, ox, oy + 2.8 * s, oz, 0.55 * s, 0.3 * s, 7, hexC(0x62472c), hexC(0x523a23));
    fLimb(mb, ox, oy + 2.2 * s, oz, ox + 1.1 * s, oy + 4.3 * s, oz + 0.3 * s, 0.2 * s, 0.1 * s, 5, hexC(0x62472c));
    fLimb(mb, ox, oy + 2.4 * s, oz, ox - 1.0 * s, oy + 4.0 * s, oz - 0.6 * s, 0.2 * s, 0.1 * s, 5, hexC(0x62472c));
    const t = hexC(0x62ad3f), b = hexC(0x2c6a27);
    fBlob(mb, ox, oy + 5.2 * s, oz, 2.7 * s, 2.1 * s, 2.7 * s, 1, t, b, rnd, 0.14);
    fBlob(mb, ox + 1.9 * s, oy + 4.5 * s, oz + 0.7 * s, 1.8 * s, 1.5 * s, 1.8 * s, 0, t, b, rnd, 0.18);
    fBlob(mb, ox - 1.7 * s, oy + 4.6 * s, oz - 0.9 * s, 1.9 * s, 1.5 * s, 1.9 * s, 0, t, b, rnd, 0.18);
    fBlob(mb, ox + 0.3 * s, oy + 6.7 * s, oz - 0.3 * s, 1.7 * s, 1.3 * s, 1.7 * s, 0, t, b, rnd, 0.18);
    fBlob(mb, ox - 0.6 * s, oy + 4.1 * s, oz + 1.7 * s, 1.5 * s, 1.2 * s, 1.5 * s, 0, t, b, rnd, 0.18);
  }
  function treeBirch(mb, ox, oy, oz, s, rnd) {
    for (let i = 0; i < 6; i++) {
      const a = oy + i * 0.95 * s, r0 = (0.18 - i * 0.012) * s;
      fLimb(mb, ox, a - (i ? 0 : 0.2 * s), oz, ox, a + 0.95 * s, oz, r0, r0 - 0.012 * s, 5, hexC(i % 3 === 2 ? 0x3a3a38 : 0xe9e7df), hexC(0xd2d0c6));
    }
    const t = hexC(0xb2d14e), b = hexC(0x5f9a35);
    fBlob(mb, ox, oy + 5.9 * s, oz, 1.4 * s, 2.3 * s, 1.4 * s, 0, t, b, rnd, 0.2);
    fBlob(mb, ox + 0.5 * s, oy + 4.7 * s, oz + 0.3 * s, 1.15 * s, 1.5 * s, 1.15 * s, 0, t, b, rnd, 0.2);
    fBlob(mb, ox - 0.3 * s, oy + 7.4 * s, oz - 0.2 * s, 1.0 * s, 1.5 * s, 1.0 * s, 0, t, b, rnd, 0.2);
  }
  function treeBush(mb, ox, oy, oz, s, rnd) {
    const t = hexC(0x5b9140), b = hexC(0x2d5a28);
    fBlob(mb, ox, oy + 0.5 * s, oz, 1.0 * s, 0.8 * s, 1.0 * s, 0, t, b, rnd, 0.2, -0.5);
    fBlob(mb, ox + 0.8 * s, oy + 0.35 * s, oz + 0.4 * s, 0.7 * s, 0.55 * s, 0.7 * s, 0, t, b, rnd, 0.2, -0.5);
    fBlob(mb, ox - 0.6 * s, oy + 0.3 * s, oz - 0.5 * s, 0.6 * s, 0.5 * s, 0.6 * s, 0, t, b, rnd, 0.2, -0.5);
  }
  function treeDead(mb, ox, oy, oz, s, rnd) {
    const c = hexC(0x6c5c4c), c2 = hexC(0x544638);
    fLimb(mb, ox, oy - 0.2 * s, oz, ox + 0.15 * s, oy + 5.2 * s, oz, 0.34 * s, 0.1 * s, 5, c, c2);
    for (let i = 0; i < 4; i++) {
      const a = rnd() * Math.PI * 2, y0 = oy + (2 + i * 0.8) * s, l = (1.4 - i * 0.2) * s;
      fLimb(mb, ox, y0, oz, ox + Math.cos(a) * l, y0 + l * 0.8, oz + Math.sin(a) * l, 0.11 * s, 0.04 * s, 4, c, c2);
    }
  }
  const TREE_BUILDERS = { spruce: treeSpruce, pine: treePine, oak: treeOak, birch: treeBirch, bush: treeBush, dead: treeDead };

  // ---------- skały ----------
  function rockBoulder(mb, rnd, rx, ry, rz, level) {
    const base = hexC(0x8b8a86), faces = ICO_CACHE[level], jmap = new Map();
    const place = u => {
      const key = Math.round(u[0] * 500) + ',' + Math.round(u[1] * 500) + ',' + Math.round(u[2] * 500);
      let j = jmap.get(key);
      if (j === undefined) { j = 0.72 + rnd() * 0.5; jmap.set(key, j); }
      return [u[0] * rx * j, Math.max(u[1] * ry * j, -0.38 * ry), u[2] * rz * j];
    };
    for (const f of faces) {
      const ny = (f[0][1] + f[1][1] + f[2][1]) / 3;
      const c = shadeC(base, (0.86 + ny * 0.14) * (0.93 + rnd() * 0.14));
      mb.tri(place(f[0]), place(f[1]), place(f[2]), [0, 0, 0], c);
    }
  }
  function rockSpire(mb, rnd, height) {
    const layers = 4, seg = 6, rings = [];
    let lean = [0, 0];
    for (let i = 0; i <= layers; i++) {
      const y = i / layers * height, r = (1.1 - i * 0.2) * (0.85 + rnd() * 0.3);
      lean = [lean[0] + (rnd() - 0.5) * 0.35, lean[1] + (rnd() - 0.5) * 0.35];
      const ring = [];
      for (let k = 0; k < seg; k++) {
        const a = k / seg * Math.PI * 2 + (rnd() - 0.5) * 0.35, rr = i === layers ? 0.06 : r * (0.8 + rnd() * 0.4);
        ring.push([lean[0] + Math.cos(a) * rr, y, lean[1] + Math.sin(a) * rr]);
      }
      rings.push(ring);
    }
    for (let i = 0; i < layers; i++) {
      const c0 = shadeC(hexC(i % 2 ? 0x938f87 : 0x7c7a75), 0.9 + i * 0.05);
      const cen = rg => [rg.reduce((a, p) => a + p[0], 0) / seg, rg.reduce((a, p) => a + p[2], 0) / seg];
      const c1 = cen(rings[i]), c2 = cen(rings[i + 1]);
      const ref = [(c1[0] + c2[0]) / 2, (i + 0.5) / layers * height, (c1[1] + c2[1]) / 2];
      for (let k = 0; k < seg; k++) {
        const k2 = (k + 1) % seg, c = shadeC(c0, 0.9 + rnd() * 0.2);
        mb.tri(rings[i][k], rings[i][k2], rings[i + 1][k2], ref, c);
        mb.tri(rings[i][k], rings[i + 1][k2], rings[i + 1][k], ref, c);
      }
    }
  }

  function geoOf(fn) { const mb = new MeshBuilder(); fn(mb); const m = mb.toMesh(plainMat); return m ? m.geometry : null; }
  const FLORA = { trees: {}, rocks: [] };
  const sharedGeos = new Set();
  for (const name in TREE_BUILDERS) {
    const g = geoOf(mb => TREE_BUILDERS[name](mb, 0, 0, 0, 1, mulberry32(name.length * 7919 + 3)));
    FLORA.trees[name] = g; sharedGeos.add(g);
  }
  // 0-3: głazy (okrągły, płaski, wysoki, duży poszarpany), 4-5: iglice skalne
  [[1, 0.8, 0.9, 0, 11], [1.15, 0.5, 0.95, 0, 23], [0.8, 1.15, 0.8, 0, 37], [1, 0.85, 1, 1, 41]].forEach(r => {
    const g = geoOf(mb => rockBoulder(mb, mulberry32(r[4]), r[0], r[1], r[2], r[3]));
    FLORA.rocks.push(g); sharedGeos.add(g);
  });
  [[4.2, 53], [5.0, 59]].forEach(r => {
    const g = geoOf(mb => rockSpire(mb, mulberry32(r[1]), r[0]));
    FLORA.rocks.push(g); sharedGeos.add(g);
  });
  const ROCK_SPIRE0 = 4;

  // ======================= MIASTA (budowa kwartałów) =======================
  // Każde miasto ma styl (metropolia, miasto, miasteczko, dzielnica przemysłowa, stare miasto), paletę kolorów,
  // własną wielkość kwartału i kilka centrów zabudowy; typ każdego kwartału zależy od gęstości w tym miejscu.
  const colHex = h => new THREE.Color(h);
  const PARK_GREEN = [0x5f9a45, 0x6aa84f, 0x558a3e, 0x4f8a3a];
  const METAL = [0x8d949a, 0xa8a08c, 0x7d8a94, 0xb0a99a, 0x9aa3a0];
  const CONTAINERS = [0xb5483a, 0x3a6ea5, 0xd0a02a, 0x4f8a52, 0x8b8f93, 0xc9c4b4];
  const TREE_NAMES = ['oak', 'oak', 'oak', 'birch', 'birch', 'spruce', 'bush'];

  function buildCity(group, city, x0, z0) {
    const x1 = x0 + CHUNK, z1 = z0 + CHUNK;
    const nx = clamp(city.x, x0, x1), nz = clamp(city.z, z0, z1);
    if (Math.hypot(nx - city.x, nz - city.z) > city.r) return;   // chunk poza miastem

    const S = CITY_STYLES[city.style], PAL = PALETTES[city.pal];
    const P = city.P, hw = ROAD_W / 2, U = P - ROAD_W, gy = city.h, maxR = city.r - 6;
    const roads = new MeshBuilder(), blds = new MeshBuilder(), plain = new MeshBuilder(), boxes = [];
    const nearCross = rel => { const t = ((rel % P) + P) % P; return Math.abs(t - P / 2) < hw + 1.2; };
    const solid = (cx, y0, cz, w, h, d, color) => {
      blds.box(cx, y0, cz, w, h, d, color);
      boxes.push({ x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2, top: y0 + h });
    };
    const solidRound = (cx, y0, cz, r, h, seg, color, apex, windows, rot) => {
      (windows ? blds : plain).prism(cx, y0, cz, r, h, seg, color, apex, rot || 0, windows);
      boxes.push({ x0: cx - r, x1: cx + r, z0: cz - r, z1: cz + r, top: y0 + h });
    };

    // --- ulice biegnące wzdłuż Z (stałe X) ---
    const ka = Math.ceil((x0 - hw - city.x) / P - 0.5), kb = Math.floor((x1 + hw - city.x) / P - 0.5);
    for (let k = ka; k <= kb; k++) {
      const X = city.x + (k + 0.5) * P, dx = X - city.x;
      if (Math.abs(dx) >= maxR) continue;
      const half = Math.sqrt(maxR * maxR - dx * dx);
      const za = Math.max(city.z - half, z0), zb = Math.min(city.z + half, z1);
      const xa = Math.max(X - hw, x0), xb = Math.min(X + hw, x1);
      if (zb <= za || xb <= xa) continue;
      roads.flatQuad(xa, za, xb, zb, gy + 0.08, ROAD_COLOR);
      if (X >= x0 && X <= x1) {
        for (let zz = Math.ceil(za / 6) * 6; zz + 3 <= zb; zz += 6) {
          if (nearCross(zz + 1.5 - city.z)) continue;
          roads.flatQuad(X - 0.15, zz, X + 0.15, zz + 3, gy + 0.2, LINE_COLOR);
        }
      }
    }
    // --- ulice biegnące wzdłuż X (stałe Z) ---
    const la = Math.ceil((z0 - hw - city.z) / P - 0.5), lb = Math.floor((z1 + hw - city.z) / P - 0.5);
    for (let k = la; k <= lb; k++) {
      const Z = city.z + (k + 0.5) * P, dz = Z - city.z;
      if (Math.abs(dz) >= maxR) continue;
      const half = Math.sqrt(maxR * maxR - dz * dz);
      const xa = Math.max(city.x - half, x0), xb = Math.min(city.x + half, x1);
      const za = Math.max(Z - hw, z0), zb = Math.min(Z + hw, z1);
      if (xb <= xa || zb <= za) continue;
      roads.flatQuad(xa, za, xb, zb, gy + 0.08, ROAD_COLOR);
      if (Z >= z0 && Z <= z1) {
        for (let xx = Math.ceil(xa / 6) * 6; xx + 3 <= xb; xx += 6) {
          if (nearCross(xx + 1.5 - city.x)) continue;
          roads.flatQuad(xx, Z - 0.15, xx + 3, Z + 0.15, gy + 0.2, LINE_COLOR);
        }
      }
    }

    // ---------- typy kwartałów ----------
    function houses(bx, bz, rnd) {
      const cs = U / 2, off = cs / 2;
      for (const ox of [-off, off]) {
        for (const oz of [-off, off]) {
          if (rnd() < 0.15) continue;
          const w = cs * (0.62 + rnd() * 0.22), d = cs * (0.62 + rnd() * 0.22);
          const hx = bx + ox + (rnd() - 0.5) * cs * 0.1, hz = bz + oz + (rnd() - 0.5) * cs * 0.1;
          const body = pick(PAL.house, rnd), roof = pick(PAL.roof, rnd), t = rnd();
          let wh = 3.2 + rnd() * 1.6 + (rnd() < 0.2 ? 3 : 0);
          if (t < 0.34) {                       // dach czterospadowy
            solid(hx, gy, hz, w, wh, d, body);
            blds.hip(hx, gy + wh, hz, w, d, 2 + rnd() * 1.2, 0.35, roof);
          } else if (t < 0.64) {                // dach dwuspadowy
            solid(hx, gy, hz, w, wh, d, body);
            blds.gable(hx, gy + wh, hz, w, d, 1.8 + rnd() * 1.4, 0.3, rnd() < 0.5, roof);
          } else if (t < 0.82) {                // nowoczesny, płaski dach z piętrem
            wh = 3.3 + rnd() * 1.6;
            solid(hx, gy, hz, w, wh, d, body);
            blds.box(hx, gy + wh, hz, w + 0.8, 0.35, d + 0.8, roof);
            if (rnd() < 0.6) solid(hx + (rnd() - 0.5) * w * 0.3, gy + wh + 0.35, hz, w * 0.6, 2.8, d * 0.65, pick(PAL.house, rnd));
          } else {                              // wąska kamienica
            wh = 6.5 + rnd() * 2.5;
            solid(hx, gy, hz, w * 0.82, wh, d, body);
            blds.gable(hx, gy + wh, hz, w * 0.82, d, 2.4, 0.25, rnd() < 0.5, roof);
          }
          if (rnd() < 0.3) treeBush(plain, hx + (rnd() < 0.5 ? -1 : 1) * (w / 2 + 0.55), gy, hz + (rnd() - 0.5) * d, 0.5 + rnd() * 0.3, rnd);
        }
      }
    }

    function tower(bx, bz, rnd, den) {
      const core = clamp((den - S.towerAt) / Math.max(0.05, 1 - S.towerAt), 0, 1);
      const total = (24 + core * (36 + rnd() * 50) + rnd() * 14) * city.tall;
      const podH = 4 + rnd() * 4;
      const pw = U * (0.82 + rnd() * 0.15), pd = U * (0.82 + rnd() * 0.15);
      solid(bx, gy, bz, pw, podH, pd, pick(PAL.conc, rnd));
      const tw = U * (0.55 + rnd() * 0.25), td = U * (0.55 + rnd() * 0.25);
      const tx = bx + (rnd() - 0.5) * (pw - tw) * 0.6, tz = bz + (rnd() - 0.5) * (pd - td) * 0.6;
      const col = pick(PAL.glass, rnd), ht = total - podH, y = gy + podH, kind = rnd();
      if (kind < 0.26 && ht > 38) {             // dwustopniowy
        const h1 = ht * 0.65;
        solid(tx, y, tz, tw, h1, td, col);
        solid(tx, y + h1, tz, tw * 0.7, ht - h1, td * 0.7, col);
      } else if (kind < 0.44) {                 // „tort weselny” z iglicą
        const h1 = ht * 0.5, h2 = ht * 0.3, h3 = ht * 0.2, c2 = pick(PAL.glass, rnd);
        solid(tx, y, tz, tw, h1, td, col);
        solid(tx, y + h1, tz, tw * 0.78, h2, td * 0.78, c2);
        solid(tx, y + h1 + h2, tz, tw * 0.55, h3, td * 0.55, col);
        plain.box(tx, y + ht, tz, 0.5, 8 + rnd() * 10, 0.5, GRAY);
      } else if (kind < 0.58) {                 // bliźniacze wieże
        const ax = rnd() < 0.5, sep = U * 0.2, w2 = tw * 0.62, d2 = td * 0.62;
        const h1 = ht, h2 = ht * (0.72 + rnd() * 0.2);
        solid(tx + (ax ? -sep : 0), y, tz + (ax ? 0 : -sep), w2, h1, d2, col);
        solid(tx + (ax ? sep : 0), y, tz + (ax ? 0 : sep), w2, h2, d2, col);
        blds.box(tx, y + h2 * 0.6, tz, ax ? sep * 2 : w2 * 0.5, 3, ax ? d2 * 0.5 : sep * 2, col);
      } else if (kind < 0.72) {                 // płyta
        const wide = U * 0.86, thin = U * 0.36, sw = rnd() < 0.5;
        const hh = ht * (0.7 + rnd() * 0.2);
        solid(bx, y, bz, sw ? wide : thin, hh, sw ? thin : wide, col);
        plain.box(bx, y + hh, bz, 2.4, 2, 2.4, GRAY);
      } else if (kind < 0.86) {                 // okrągła wieża
        const r = U * (0.27 + rnd() * 0.06);
        solidRound(tx, y, tz, r, ht, 12, col, 0, true, rnd());
        plain.prism(tx, y + ht, tz, r * 0.5, 2.2, 8, colHex(0x6d7176), 0, 0, false);
      } else {                                  // klasyczna szklana bryła
        solid(tx, y, tz, tw, ht, td, col);
      }
      if (total > 75) plain.box(tx, gy + total, tz, 0.5, 6 + rnd() * 8, 0.5, GRAY);
    }

    function mid(bx, bz, rnd, den) {
      const hm = clamp(city.tall, 0.45, 1.3);
      const h = (8 + rnd() * 14 + den * 8) * hm, col = pick(PAL.mid, rnd), v = rnd();
      if (S.old || (v < 0.22 && !S.industrial)) {            // rząd kamienic (każda w innym kolorze)
        const alongX = rnd() < 0.5, n = 3 + Math.floor(rnd() * 2), wRow = U / n, dRow = U * 0.43;
        for (const side of [-1, 1]) {
          for (let k = 0; k < n; k++) {
            const off = -U / 2 + wRow * (k + 0.5), sd = side * (U * 0.25);
            const cxh = alongX ? bx + off : bx + sd, czh = alongX ? bz + sd : bz + off;
            const w = alongX ? wRow * 0.96 : dRow, d = alongX ? dRow : wRow * 0.96;
            const hh = (7 + rnd() * 8) * Math.max(hm, 0.85);
            solid(cxh, gy, czh, w, hh, d, pick(PAL.mid, rnd));
            blds.gable(cxh, gy + hh, czh, w, d, 2.2 + rnd() * 1.2, 0.2, !alongX, pick(PAL.roof, rnd));
          }
        }
      } else if (v < 0.5) {                                  // budynek w kształcie litery L
        const sx = rnd() < 0.5 ? -1 : 1, sz = rnd() < 0.5 ? -1 : 1;
        solid(bx, gy, bz + sz * U * 0.25, U * 0.9, h, U * 0.4, col);
        solid(bx + sx * U * 0.25, gy, bz - sz * U * 0.05, U * 0.4, h * 0.8, U * 0.8, col);
        plain.box(bx + (rnd() - 0.5) * 4, gy + h, bz + sz * U * 0.25, 2.6, 1.6, 2.6, GRAY);
      } else if (v < 0.7) {                                  // zabudowa z dziedzińcem
        const t = U * 0.26, hh = () => h * (0.85 + rnd() * 0.3);
        solid(bx, gy, bz - (U / 2 - t / 2), U * 0.96, hh(), t, col);
        solid(bx, gy, bz + (U / 2 - t / 2), U * 0.96, hh(), t, col);
        solid(bx - (U / 2 - t / 2), gy, bz, t, hh(), U - 2 * t, col);
        solid(bx + (U / 2 - t / 2), gy, bz, t, hh(), U - 2 * t, col);
        roads.flatQuad(bx - U * 0.2, bz - U * 0.2, bx + U * 0.2, bz + U * 0.2, gy + 0.1, colHex(PARK_GREEN[Math.floor(rnd() * 4)]));
        treeOak(plain, bx, gy + 0.1, bz, 0.7, rnd);
      } else {                                               // zwykły blok
        const w = U * (0.72 + rnd() * 0.22), dd = U * (0.72 + rnd() * 0.22);
        solid(bx, gy, bz, w, h, dd, col);
        if (h < 15 && rnd() < 0.45) blds.gable(bx, gy + h, bz, w, dd, 2.5, 0.3, rnd() < 0.5, pick(PAL.roof, rnd));
        else plain.box(bx + (rnd() - 0.5) * 5, gy + h, bz + (rnd() - 0.5) * 5, 3, 1.8, 3, GRAY);
      }
    }

    function park(bx, bz, rnd) {
      const h2 = U / 2;
      roads.flatQuad(bx - h2, bz - h2, bx + h2, bz + h2, gy + 0.1, colHex(PARK_GREEN[Math.floor(rnd() * 4)]));
      roads.flatQuad(bx - 0.7, bz - h2, bx + 0.7, bz + h2, gy + 0.13, colHex(0xc9bfa3));
      if (rnd() < 0.7) roads.flatQuad(bx - h2, bz - 0.7, bx + h2, bz + 0.7, gy + 0.13, colHex(0xc9bfa3));
      if (rnd() < 0.3) roads.flatQuad(bx + U * 0.12, bz + U * 0.12, bx + U * 0.34, bz + U * 0.32, gy + 0.16, colHex(0x4a86b5));
      const n = 4 + Math.floor(rnd() * 5);
      for (let k = 0; k < n; k++) {
        const x = bx + (rnd() - 0.5) * U * 0.84, z = bz + (rnd() - 0.5) * U * 0.84;
        if (Math.abs(x - bx) < 1.6 || Math.abs(z - bz) < 1.6) continue;
        TREE_BUILDERS[TREE_NAMES[Math.floor(rnd() * TREE_NAMES.length)]](plain, x, gy + 0.1, z, 0.8 + rnd() * 0.35, rnd);
      }
    }

    function plaza(bx, bz, rnd) {
      const h2 = U / 2, stone = colHex(0x9c9a94), cream = colHex(0xe6dcc4);
      roads.flatQuad(bx - h2, bz - h2, bx + h2, bz + h2, gy + 0.1, colHex(0xb7b2a6));
      const fz = bz + U * 0.22;
      plain.prism(bx, gy + 0.1, fz, 2.4, 0.7, 14, stone, 0, 0, false);
      plain.prism(bx, gy + 0.7, fz, 2.1, 0.12, 14, colHex(0x4a86b5), 0, 0, false);
      plain.prism(bx, gy + 0.7, fz, 0.35, 2.4, 8, stone, 0, 0, false);
      boxes.push({ x0: bx - 2.4, x1: bx + 2.4, z0: fz - 2.4, z1: fz + 2.4, top: gy + 0.8 });
      if (rnd() < 0.8) {                          // kościół: nawa + wieża z hełmem
        const nz2 = bz - U * 0.2;
        solid(bx, gy, nz2, U * 0.38, 8, U * 0.5, cream);
        blds.gable(bx, gy + 8, nz2, U * 0.38, U * 0.5, 3.5, 0.3, false, pick(PAL.roof, rnd));
        const tz2 = nz2 + U * 0.25 + 1.8;
        solid(bx, gy, tz2, 4.2, 17, 4.2, cream);
        blds.hip(bx, gy + 17, tz2, 4.2, 4.2, 7, 0.3, pick(PAL.roof, rnd));
      }
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) if (rnd() < 0.6) treeBirch(plain, bx + sx * h2 * 0.82, gy + 0.1, bz + sz * h2 * 0.82, 0.75, rnd);
    }

    function industrial(bx, bz, rnd) {
      const v = rnd();
      if (v < 0.42) {                              // hale
        const alongX = rnd() < 0.5;
        for (const sd of [-1, 1]) {
          if (rnd() < 0.12) continue;
          const w = alongX ? U * 0.92 : U * 0.4, d = alongX ? U * 0.4 : U * 0.92, hh = 6 + rnd() * 3.5;
          const cx2 = alongX ? bx : bx + sd * U * 0.25, cz2 = alongX ? bz + sd * U * 0.25 : bz;
          solid(cx2, gy, cz2, w, hh, d, pick(METAL, rnd));
          blds.gable(cx2, gy + hh, cz2, w, d, 1.5, 0.2, alongX, colHex(0x6b6f74));
        }
      } else if (v < 0.66) {                       // zbiorniki / silosy
        const r = U * 0.17;
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          if (rnd() < 0.15) continue;
          solidRound(bx + sx * U * 0.24, gy, bz + sz * U * 0.24, r, 9 + rnd() * 6, 12, pick([0xd7dadb, 0xc4c8c9, 0xb9c2c7], rnd), 1.8, false, 0);
        }
        plain.box(bx, gy, bz, U * 0.5, 0.7, 0.7, colHex(0x777b80));
      } else if (v < 0.82) {                       // fabryka z kominem
        solid(bx - U * 0.08, gy, bz + U * 0.1, U * 0.7, 8 + rnd() * 3, U * 0.55, pick(METAL, rnd));
        const cxm = bx + U * 0.32, czm = bz - U * 0.3, n = 7 + Math.floor(rnd() * 3);
        for (let k = 0; k < n; k++) plain.box(cxm, gy + k * 4.5, czm, 2.4 - k * 0.12, 4.5, 2.4 - k * 0.12, colHex(k % 2 ? 0xe8e6de : 0xb5483a));
        boxes.push({ x0: cxm - 1.2, x1: cxm + 1.2, z0: czm - 1.2, z1: czm + 1.2, top: gy + n * 4.5 });
      } else {                                     // skład kontenerów
        for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) {
          if (rnd() < 0.15) continue;
          const stack = 1 + Math.floor(rnd() * 3), cx2 = bx - U * 0.34 + i * U * 0.34, cz2 = bz - U * 0.375 + j * U * 0.25;
          for (let s = 0; s < stack; s++) plain.box(cx2, gy + s * 2.6, cz2, 2.6, 2.5, 6, colHex(CONTAINERS[Math.floor(rnd() * CONTAINERS.length)]));
          boxes.push({ x0: cx2 - 1.3, x1: cx2 + 1.3, z0: cz2 - 3, z1: cz2 + 3, top: gy + stack * 2.6 });
        }
      }
    }

    function lot(bx, bz, rnd) {
      roads.flatQuad(bx - U / 2, bz - U / 2, bx + U / 2, bz + U / 2, gy + 0.1, colHex(S.industrial ? 0x8a8578 : PARK_GREEN[Math.floor(rnd() * 4)]));
      if (S.industrial) return;
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) treeBush(plain, bx + (rnd() - 0.5) * U * 0.7, gy + 0.1, bz + (rnd() - 0.5) * U * 0.7, 0.8 + rnd() * 0.5, rnd);
    }

    // --- kwartały (każdy przypisany do chunka, w którym leży jego środek) ---
    const hub0 = city.hubs[0];
    const ga = Math.ceil((x0 - city.x) / P), gb = Math.ceil((x1 - city.x) / P) - 1;
    const ha = Math.ceil((z0 - city.z) / P), hb = Math.ceil((z1 - city.z) / P) - 1;
    for (let gi = ga; gi <= gb; gi++) {
      for (let gj = ha; gj <= hb; gj++) {
        const bx = city.x + gi * P, bz = city.z + gj * P;
        const d = Math.hypot(bx - city.x, bz - city.z);
        if (d > city.r - 12) continue;
        const rnd = mulberry32(hash2(gi * 131 + (city.x | 0), gj * 977 + (city.z | 0)));

        // gęstość: najbliższe centrum zabudowy + zanikanie ku brzegowi + nieregularne plamy
        let best = 0;
        for (const h of city.hubs) best = Math.max(best, 1 - Math.hypot(bx - h.x, bz - h.z) / h.r);
        const den = clamp(best * 0.85 + clamp(1 - d / city.r, 0, 1) * 0.3 + perlin.noise(bx * 0.02 + city.x * 0.01, bz * 0.02) * 0.12, 0, 1);
        const isHub0 = Math.hypot(bx - hub0.x, bz - hub0.z) < P * 0.7;

        if (isHub0 && (S.old || (S.towerAt > 5 && !S.industrial)) && rnd() < 0.85) plaza(bx, bz, rnd);
        else if (!isHub0 && rnd() < S.park * (0.6 + (1 - den) * 1.2)) park(bx, bz, rnd);
        else if (S.industrial) {
          if (den > 0.3 && rnd() < 0.9) industrial(bx, bz, rnd);
          else if (rnd() < 0.75) houses(bx, bz, rnd);
          else lot(bx, bz, rnd);
        }
        else if (den >= S.towerAt && rnd() < 0.92) tower(bx, bz, rnd, den);
        else if (den >= S.midAt && rnd() < 0.9) mid(bx, bz, rnd, den);
        else if (rnd() < 0.93) houses(bx, bz, rnd);
        else lot(bx, bz, rnd);
      }
    }

    const rm = roads.toMesh(roadMat);
    if (rm) group.add(rm);
    const bm = blds.toMesh(buildingMat);
    if (bm) group.add(bm);
    const pm = plain.toMesh(plainMat);
    if (pm) group.add(pm);
    if (boxes.length) buildBoxes.set(group.userData.key, boxes);
  }

  // ======================= CHUNKI (teren z LOD, drzewa, miasta, drogi) =======================
  const chunks = new Map();
  const dummy = new THREE.Object3D();

  // poziom szczegółowości wg odległości (w chunkach); histereza zapobiega migotaniu na granicach
  function lodFor(dist, cur) {
    let l = 0;
    for (let k = 0; k < LOD_DIST.length; k++) {
      let thr = LOD_DIST[k];
      if (cur !== undefined) thr += (cur > k ? -0.45 : 0.45);   // histereza: poziom zmieniamy dopiero z zapasem
      if (dist >= thr) l = k + 1;
    }
    return l;
  }

  function buildChunk(cx, cz, lod) {
    const group = new THREE.Group();
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const RES = LOD_RES[lod];
    const step = CHUNK / RES;
    const city = getCity(Math.floor(x0 / CITY_CELL), Math.floor(z0 / CITY_CELL));

    // drogi najpierw: rejestrują wykopy, które zmieniają wysokość terenu
    const roads = getChunkRoads(x0, z0);

    // siatka wysokości z marginesem 1 pola: każdą wysokość liczymy raz, normalne bierzemy z sąsiadów
    const GW = RES + 3;
    const hg = new Float32Array(GW * GW);
    for (let gz = 0; gz < GW; gz++) {
      for (let gx = 0; gx < GW; gx++) {
        hg[gz * GW + gx] = getHeight(x0 + (gx - 1) * step, z0 + (gz - 1) * step);
      }
    }

    const side = RES + 1;
    const vCount = side * side;
    const skirtCount = RES * 4;
    const pos = new Float32Array((vCount + skirtCount) * 3);
    const nor = new Float32Array((vCount + skirtCount) * 3);
    const col = new Float32Array((vCount + skirtCount) * 3);
    const idx = new Uint16Array(RES * RES * 6 + RES * 4 * 6);
    const c = [0, 0, 0];

    let i = 0;
    for (let iz = 0; iz <= RES; iz++) {
      for (let ix = 0; ix <= RES; ix++) {
        const x = x0 + ix * step, z = z0 + iz * step;
        const gi = (iz + 1) * GW + (ix + 1);
        const h = hg[gi];
        pos[i] = x; pos[i + 1] = h; pos[i + 2] = z;

        // normalne liczone z funkcji wysokości – brak szwów między chunkami
        let nx = hg[gi - 1] - hg[gi + 1], ny = 2 * step, nz = hg[gi - GW] - hg[gi + GW];
        const len = Math.hypot(nx, ny, nz);
        nx /= len; ny /= len; nz /= len;
        nor[i] = nx; nor[i + 1] = ny; nor[i + 2] = nz;

        terrainColor(h, 1 - ny, x, z, c);
        if (city) {
          // pod miastem teren jest betonowo-szary, na obrzeżach płynnie przechodzi w trawę
          const dd = Math.hypot(x - city.x, z - city.z);
          if (dd < city.r + CITY_BLEND) {
            const t = dd <= city.r ? 0 : (dd - city.r) / CITY_BLEND;
            const k = 1 - t * t * (3 - 2 * t);
            const g = 0.52 + perlin.noise(x * 0.3, z * 0.3) * 0.03;
            c[0] += (g - c[0]) * k;
            c[1] += (g + 0.01 - c[1]) * k;
            c[2] += (g - 0.01 - c[2]) * k;
          }
        }
        col[i] = c[0]; col[i + 1] = c[1]; col[i + 2] = c[2];
        i += 3;
      }
    }

    // przy portalach tuneli pomijamy trójkąty terenu, które wchodziłyby do wnętrza tunelu (zasłaniałyby wejście)
    const zones = lod === 0 && roads.length ? portalZones(roads, x0, z0) : [];
    let k = 0;
    for (let iz = 0; iz < RES; iz++) {
      for (let ix = 0; ix < RES; ix++) {
        const a = iz * side + ix, b = a + 1, d = a + side, e = d + 1;
        if (zones.length) {
          const ya = pos[a * 3 + 1], yb = pos[b * 3 + 1], yd = pos[d * 3 + 1], ye = pos[e * 3 + 1];
          const px0 = x0 + ix * step, pz0 = z0 + iz * step;
          const t1 = inHood(zones, px0 + step * 0.33, pz0 + step * 0.67, Math.min(ya, yd, yb));
          const t2 = inHood(zones, px0 + step * 0.67, pz0 + step * 0.33, Math.min(yb, yd, ye));
          if (!t1) { idx[k++] = a; idx[k++] = d; idx[k++] = b; }
          if (!t2) { idx[k++] = b; idx[k++] = d; idx[k++] = e; }
          continue;
        }
        idx[k++] = a; idx[k++] = d; idx[k++] = b;
        idx[k++] = b; idx[k++] = d; idx[k++] = e;
      }
    }

    // „spódniczki” wzdłuż krawędzi chunka maskują szpary między sąsiadami o różnym LOD
    const skirtDrop = [2, 6, 16, 40][lod];
    let sv = vCount;
    const edge = [];
    for (let q = 0; q < RES; q++) edge.push(q);                                   // z = z0, x rosnąco
    for (let q = 0; q < RES; q++) edge.push(q * side + RES);                      // x = x1
    for (let q = RES; q > 0; q--) edge.push(RES * side + q);                      // z = z1, x malejąco
    for (let q = RES; q > 0; q--) edge.push(q * side);                            // x = x0
    const nextOf = new Map();
    for (let q = 0; q < edge.length; q++) nextOf.set(edge[q], edge[(q + 1) % edge.length]);
    const skirtIdx = new Map();
    for (const v of edge) {
      skirtIdx.set(v, sv);
      pos[sv * 3] = pos[v * 3]; pos[sv * 3 + 1] = pos[v * 3 + 1] - skirtDrop; pos[sv * 3 + 2] = pos[v * 3 + 2];
      nor[sv * 3] = nor[v * 3]; nor[sv * 3 + 1] = nor[v * 3 + 1]; nor[sv * 3 + 2] = nor[v * 3 + 2];
      col[sv * 3] = col[v * 3]; col[sv * 3 + 1] = col[v * 3 + 1]; col[sv * 3 + 2] = col[v * 3 + 2];
      sv++;
    }
    for (const v of edge) {
      const w = nextOf.get(v), sa = skirtIdx.get(v), sb = skirtIdx.get(w);
      // spódniczka zwrócona na zewnątrz chunka (tam, gdzie widać szparę)
      idx[k++] = v; idx[k++] = w; idx[k++] = sa;
      idx[k++] = w; idx[k++] = sb; idx[k++] = sa;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, k), 1));
    geo.computeBoundingSphere();
    const terrain = new THREE.Mesh(geo, terrainMat);
    terrain.material = terrainMat;
    group.add(terrain);

    group.userData.key = cx + ',' + cz;
    group.userData.cx = cx;
    group.userData.cz = cz;
    group.userData.lod = lod;

    // szczegóły (drzewa, miasto, drogi) tylko dla bliższych poziomów LOD
    if (lod <= 2 && roads.length) buildRoads(group, roads, x0, z0);
    if (lod <= 2 && city) buildCity(group, city, x0, z0);
    if (lod <= 1) buildFlora(group, cx, cz, x0, z0, city, roads, lod);

    scene.add(group);
    return group;
  }

  // gatunek drzewa zależy od wysokości i wolno zmiennej „strefy” (płaty lasu liściastego, sosnowego, świerkowego)
  function pickSpecies(x, z, h, rand) {
    const zn = perlin.noise(x * 0.004 + 900, z * 0.004 - 900);
    const hi = smooth01(30, 85, h), tl = smooth01(TREE_LINE - 45, TREE_LINE, h);
    const w = [
      ['spruce', 0.25 + 1.4 * hi + (zn > 0.2 ? 0.4 : 0)],
      ['pine', 0.15 + (zn > 0 ? 0.9 : 0.2) * (1 - smooth01(70, 110, h))],
      ['oak', (1 - hi) * (zn < 0.15 ? 1.2 : 0.35)],
      ['birch', (1 - hi) * (zn > -0.1 ? 0.7 : 0.15) * (zn > 0.3 ? 1.5 : 1)],
      ['bush', 0.35 * (1 - tl)],
      ['dead', 0.03 + 0.55 * tl]
    ];
    let sum = 0;
    for (const e of w) sum += e[1];
    let r = rand() * sum;
    for (const e of w) { r -= e[1]; if (r <= 0) return e[0]; }
    return 'spruce';
  }

  const AUTUMN = [[1.9, 1.05, 0.35], [1.6, 0.75, 0.45], [2.0, 1.6, 0.5], [1.7, 0.55, 0.35]];
  const _tc = new THREE.Color();

  function buildFlora(group, cx, cz, x0, z0, city, roads, lod) {
    // punkty osi dróg w pobliżu chunka – roślinność i skały ich unikają
    const roadPts = [];
    for (const road of roads) {
      for (const sp of road.s) {
        if (sp.x > x0 - 12 && sp.x < x0 + CHUNK + 12 && sp.z > z0 - 12 && sp.z < z0 + CHUNK + 12) roadPts.push(sp.x, sp.z);
      }
    }
    const nearRoad = (x, z, d) => {
      const d2 = d * d;
      for (let q = 0; q < roadPts.length; q += 2) {
        const dx = x - roadPts[q], dz = z - roadPts[q + 1];
        if (dx * dx + dz * dz < d2) return true;
      }
      return false;
    };
    const inCity = (x, z) => city && Math.hypot(x - city.x, z - city.z) < city.r + CITY_BLEND;

    const rand = mulberry32(hash2(cx, cz));
    const solids = [];

    // ---- drzewa i krzewy ----
    const lists = { spruce: [], pine: [], oak: [], birch: [], bush: [], dead: [] };
    const MAX_TREES = lod === 0 ? 80 : 40;
    let count = 0;
    for (let t = 0; t < 150 && count < MAX_TREES; t++) {
      const x = x0 + rand() * CHUNK, z = z0 + rand() * CHUNK;
      const forest = perlin.noise(x * 0.008 + 300, z * 0.008 + 300);
      const chance = rand();
      if (forest < -0.05 && chance > 0.25) continue;
      const h = getHeight(x, z);
      if (h < WATER_LEVEL + 1.6 || h > TREE_LINE) continue;
      if (inCity(x, z)) continue;
      if (nearRoad(x, z, 7)) continue;
      if (Math.abs(getHeight(x + 2, z) - h) > 1.6 || Math.abs(getHeight(x, z + 2) - h) > 1.6) continue;
      const sp = pickSpecies(x, z, h, rand);
      const tl = smooth01(TREE_LINE - 45, TREE_LINE, h);
      let s = (sp === 'bush' ? 0.7 + rand() * 0.8 : 0.75 + rand() * 0.75) * lerp(1, 0.5, tl);
      const sy = s * (0.9 + rand() * 0.25);
      const zn = perlin.noise(x * 0.004 + 900, z * 0.004 - 900);
      let tint;
      if ((sp === 'oak' || sp === 'birch') && rand() < (zn > 0.3 ? 0.28 : 0.06)) tint = AUTUMN[Math.floor(rand() * AUTUMN.length)];
      else { const v = 0.84 + rand() * 0.3; tint = [v * (0.95 + rand() * 0.1), v * (0.95 + rand() * 0.14), v * (0.9 + rand() * 0.12)]; }
      lists[sp].push([x, h, z, s, sy, rand() * Math.PI * 2, tint]);
      if (sp !== 'bush') solids.push(x, z, 0.38 * s);
      count++;
    }

    // ---- skały: gromady głazów (większe i częstsze wyżej), pojedyncze kamienie, iglice na szczytach ----
    const rocks = [];
    const hc = baseHeight(x0 + CHUNK / 2, z0 + CHUNK / 2);
    const slopeC = Math.abs(baseHeight(x0 + CHUNK / 2 + 12, z0 + CHUNK / 2) - hc) / 12 + Math.abs(baseHeight(x0 + CHUNK / 2, z0 + CHUNK / 2 + 12) - hc) / 12;
    const rockiness = 0.5 + 1.8 * smooth01(40, 200, hc) + clamp(slopeC, 0, 1.2) * 1.5;
    const ROCK_MAX = lod === 0 ? 50 : 24;
    const addRock = (x, z, scale, kind, hx) => {
      if (rocks.length >= ROCK_MAX) return false;
      const h = getHeight(x, z);
      if (h < WATER_LEVEL - 0.3 || h > 900 || inCity(x, z)) return false;
      if (nearRoad(x, z, 8 + scale)) return false;
      const r = 0.7 * scale;
      const lo = Math.min(h, getHeight(x + r, z), getHeight(x - r, z), getHeight(x, z + r), getHeight(x, z - r));
      // odcień: nisko brązowawy, w górach szary, wysoko jasny/ośnieżony, przy wodzie ciemny (mokry)
      const a = smooth01(30, 160, h), sn = smooth01(SNOW_LINE - 40, SNOW_LINE + 30, h);
      let cr = lerp(1.18, 1.0, a), cg = lerp(1.02, 1.0, a), cb = lerp(0.84, 1.04, a);
      cr = lerp(cr, 1.55, sn); cg = lerp(cg, 1.55, sn); cb = lerp(cb, 1.62, sn);
      if (h < WATER_LEVEL + 1.4) { cr *= 0.75; cg *= 0.78; cb *= 0.82; }
      const v = 0.85 + rand() * 0.3;
      const sx = scale * (0.85 + rand() * 0.4), sz = scale * (0.85 + rand() * 0.4);
      rocks.push([x, lo - 0.18 * scale, z, sx, scale * (0.8 + rand() * 0.45), sz, rand() * Math.PI * 2, kind, [cr * v, cg * v, cb * v]]);
      if (kind >= ROCK_SPIRE0 ? scale > 0.9 : scale > 1.15) solids.push(x, z, 0.78 * Math.max(sx, sz));
      return true;
    };
    const nClusters = Math.min(6, Math.floor(rand() * 1.8 + rockiness * 1.2));
    for (let k = 0; k < nClusters; k++) {
      const x = x0 + rand() * CHUNK, z = z0 + rand() * CHUNK;
      const h = getHeight(x, z);
      const big = (0.9 + rand() * 1.5) * (1 + 0.9 * smooth01(80, 260, h));
      if (h > 110 && rand() < 0.35) {   // iglica skalna
        addRock(x, z, 1.0 + rand() * 1.6, ROCK_SPIRE0 + (rand() < 0.5 ? 0 : 1));
      } else if (!addRock(x, z, big, rand() < 0.3 ? 3 : Math.floor(rand() * 3))) continue;
      const n = 2 + Math.floor(rand() * (3 + rockiness * 1.5));
      for (let q = 0; q < n; q++) {
        const a = rand() * Math.PI * 2, d = big * (1.1 + rand() * 1.6);
        addRock(x + Math.cos(a) * d, z + Math.sin(a) * d, big * (0.2 + rand() * 0.38), Math.floor(rand() * 3));
      }
    }
    const singles = 6 + Math.floor(rockiness * 4);
    for (let k = 0; k < singles; k++) addRock(x0 + rand() * CHUNK, z0 + rand() * CHUNK, 0.35 + rand() * 0.6, Math.floor(rand() * 3));

    if (solids.length) treeSolids.set(cx + ',' + cz, new Float32Array(solids));

    // ---- instancje ----
    const dummy2 = dummy;
    for (const sp in lists) {
      const arr = lists[sp];
      if (!arr.length) continue;
      const mesh = new THREE.InstancedMesh(FLORA.trees[sp], plainMat, arr.length);
      arr.forEach((tr, n) => {
        dummy2.position.set(tr[0], tr[1], tr[2]);
        dummy2.rotation.set(0, tr[5], 0);
        dummy2.scale.set(tr[3], tr[4], tr[3]);
        dummy2.updateMatrix();
        mesh.setMatrixAt(n, dummy2.matrix);
        _tc.setRGB(tr[6][0], tr[6][1], tr[6][2]);
        mesh.setColorAt(n, _tc);
      });
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    const byKind = {};
    for (const r of rocks) (byKind[r[7]] = byKind[r[7]] || []).push(r);
    for (const kind in byKind) {
      const arr = byKind[kind];
      const mesh = new THREE.InstancedMesh(FLORA.rocks[kind], plainMat, arr.length);
      arr.forEach((r, n) => {
        dummy2.position.set(r[0], r[1], r[2]);
        dummy2.rotation.set(0, r[6], 0);
        dummy2.scale.set(r[3], r[4], r[5]);
        dummy2.updateMatrix();
        mesh.setMatrixAt(n, dummy2.matrix);
        _tc.setRGB(r[8][0], r[8][1], r[8][2]);
        mesh.setColorAt(n, _tc);
      });
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  }

  function disposeChunk(group) {
    scene.remove(group);
    const key = group.userData.key;
    buildBoxes.delete(key);
    roadSegs.delete(key);
    treeSolids.delete(key);
    group.traverse(o => {
      if (o.isInstancedMesh && o.dispose) o.dispose();
      else if (o.isMesh && !sharedGeos.has(o.geometry)) o.geometry.dispose();
    });
  }

  // ---- zarządzanie chunkami: ładowanie wokół gracza, zmiana LOD i usuwanie tych, które zostały z tyłu ----
  let lastPcx = null, lastPcz = null;
  let pendingChunks = [];   // kolejka do zbudowania/przebudowania; najbliższy na końcu tablicy

  // cache miast i dróg rośnie wraz z podróżą – wyrzucamy wpisy z daleka (są deterministyczne, więc wrócą w razie potrzeby)
  function pruneCaches(pcx, pcz) {
    const ci = Math.floor(pcx * CHUNK / CITY_CELL), cj = Math.floor(pcz * CHUNK / CITY_CELL);
    for (const [k, v] of cityCache) {
      if (Math.abs(v.ci - ci) > 6 || Math.abs(v.cj - cj) > 6) cityCache.delete(k);
    }
    const px = pcx * CHUNK, pz = pcz * CHUNK;
    for (const [k, v] of roadCache) {
      if (Math.hypot(v.mx - px, v.mz - pz) > 6000) {
        if (v.road) removeCarveRoad(k, v.road.cellBox);
        roadCache.delete(k);
      }
    }
  }

  function refreshChunkQueue() {
    const pcx = Math.floor(player.pos.x / CHUNK), pcz = Math.floor(player.pos.z / CHUNK);
    const vd = viewDist();

    // 1) usuń chunki spoza zasięgu: geometria z GPU, kolizje budynków, mostów i drzew
    const u2 = unload2();
    for (const [key, group] of chunks) {
      const dx = group.userData.cx - pcx, dz = group.userData.cz - pcz;
      if (dx * dx + dz * dz > u2) { disposeChunk(group); chunks.delete(key); }
    }

    // 2) kolejka brakujących chunków i tych, którym zmienił się poziom LOD (od najbliższych)
    pendingChunks = [];
    const l2 = vd * vd + 1;
    for (let dz = -vd; dz <= vd; dz++) {
      for (let dx = -vd; dx <= vd; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > l2) continue;
        const key = (pcx + dx) + ',' + (pcz + dz);
        const g = chunks.get(key);
        const want = lodFor(Math.sqrt(d2), g ? g.userData.lod : undefined);
        if (!g) pendingChunks.push([d2, pcx + dx, pcz + dz, key, want]);
        else if (g.userData.lod !== want) pendingChunks.push([d2 + 0.5, pcx + dx, pcz + dz, key, want]);
      }
    }
    pendingChunks.sort((a, b) => b[0] - a[0]);
    pruneCaches(pcx, pcz);
  }

  // msBudget – ile milisekund wolno poświęcić na budowę w tej klatce (zawsze budujemy co najmniej jeden)
  function updateChunks(msBudget) {
    const pcx = Math.floor(player.pos.x / CHUNK), pcz = Math.floor(player.pos.z / CHUNK);
    if (pcx !== lastPcx || pcz !== lastPcz) {
      lastPcx = pcx; lastPcz = pcz;
      refreshChunkQueue();
    }
    const t0 = performance.now();
    let built = 0;
    while (pendingChunks.length && (built === 0 || performance.now() - t0 < msBudget)) {
      const item = pendingChunks.pop();
      const old = chunks.get(item[3]);
      if (old) { if (old.userData.lod === item[4]) continue; disposeChunk(old); }
      chunks.set(item[3], buildChunk(item[1], item[2], item[4]));
      built++;
    }
  }

  function invalidateChunks() { lastPcx = null; lastPcz = null; }

  function clearWorldCaches() {
    for (const group of chunks.values()) disposeChunk(group);
    chunks.clear();
    cityCache.clear();
    roadCache.clear();
    carveIdx.clear();
    buildBoxes.clear();
    roadSegs.clear();
    treeSolids.clear();
    invalidateChunks();
    pendingChunks = [];
  }

  // ======================= PODŁOŻE: teren, drogi, mosty, tunele, dachy =======================
  const SURF_ROAD = 1, SURF_GRASS = 0, SURF_SAND = 2, SURF_SNOW = 3;
  let surfKind = SURF_GRASS;   // rodzaj powierzchni z ostatniego wywołania surfaceAt (do doboru tarcia)

  const ROAD_SURF_HW2 = (ROAD_HW + 0.35) * (ROAD_HW + 0.35);
  const TUN_SURF_HW2 = (TUN_HALF_W + 0.3) * (TUN_HALF_W + 0.3);

  // wysokość powierzchni, po której można jechać / chodzić w punkcie (x,z).
  // refY – wysokość „stóp” (kół): pokład mostu lub dach leżący wyżej niż refY jest ignorowany,
  // a wewnątrz tunelu (refY w jego świetle) liczy się podłoga tunelu, nie szczyt góry.
  function surfaceAt(x, z, refY) {
    let road = -Infinity, tunnel = -Infinity, roof = -Infinity;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const fx = x - cx * CHUNK, fz = z - cz * CHUNK;
    const m = 6;
    const ax = fx < m ? -1 : 0, bx = fx > CHUNK - m ? 1 : 0, az = fz < m ? -1 : 0, bz = fz > CHUNK - m ? 1 : 0;
    for (let dz = az; dz <= bz; dz++) {
      for (let dx = ax; dx <= bx; dx++) {
        const list = roadSegs.get((cx + dx) + ',' + (cz + dz));
        if (!list) continue;
        for (let q = 0; q < list.length; q++) {
          const s = list[q];
          const abx = s.bx - s.ax, abz = s.bz - s.az;
          let t = ((x - s.ax) * abx + (z - s.az) * abz) / (abx * abx + abz * abz || 1);
          // segment obowiązuje tylko wzdłuż własnej długości (z drobnym zakładem na łukach) – inaczej sąsiednie odcinki
          // na pochyłości dawałyby „schodkową” nawierzchnię
          if (t < -0.12 || t > 1.12) continue;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = x - (s.ax + abx * t), qz = z - (s.az + abz * t);
          const d2 = qx * qx + qz * qz;
          if (d2 > (s.tun ? TUN_SURF_HW2 : ROAD_SURF_HW2)) continue;
          const u = qx * s.px + qz * s.pz;
          const yc = s.ay + (s.by - s.ay) * t;
          const ye = u >= 0 ? s.ayl + (s.byl - s.ayl) * t : s.ayr + (s.byr - s.ayr) * t;
          const au = u < 0 ? -u : u;
          const y = yc + (ye - yc) * (au > ROAD_HW ? 1 : au / ROAD_HW);
          if (s.tun) {
            if (refY >= y - 0.7 && refY <= y + TUN_H + 0.4 && y > tunnel) tunnel = y;
          } else if (refY >= y - 0.5 && y > road) road = y;
        }
      }
    }
    if (tunnel > -Infinity) { surfKind = SURF_ROAD; return tunnel; }

    // dachy budynków (blisko krawędzi chunka sprawdzamy też sąsiadów – budynki wystają poza swój chunk)
    const bm = 14;
    const bax = fx < bm ? -1 : 0, bbx = fx > CHUNK - bm ? 1 : 0, baz = fz < bm ? -1 : 0, bbz = fz > CHUNK - bm ? 1 : 0;
    for (let dz = baz; dz <= bbz; dz++) {
      for (let dx = bax; dx <= bbx; dx++) {
        const list = buildBoxes.get((cx + dx) + ',' + (cz + dz));
        if (!list) continue;
        for (let q = 0; q < list.length; q++) {
          const b = list[q];
          if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && refY >= b.top - 0.6 && b.top > roof) roof = b.top;
        }
      }
    }

    const h = getHeight(x, z);
    let best = h, kind;
    if (h < WATER_LEVEL + 1.6) kind = SURF_SAND; else if (h > SNOW_LINE) kind = SURF_SNOW; else kind = SURF_GRASS;
    if (road > best) { best = road; kind = SURF_ROAD; }
    else if (road > -Infinity && road > h - 0.35) kind = SURF_ROAD;     // jezdnia równo z terenem
    if (roof > best) { best = roof; kind = SURF_ROAD; }
    surfKind = kind;
    return best;
  }

  // normalna powierzchni (różnice centralne); zwraca [nx, ny, nz]
  function surfaceNormal(x, z, refY, out) {
    const e = 0.7;
    const hl = surfaceAt(x - e, z, refY), hr = surfaceAt(x + e, z, refY);
    const hd = surfaceAt(x, z - e, refY), hu = surfaceAt(x, z + e, refY);
    let nx = hl - hr, ny = 2 * e, nz = hd - hu;
    const l = Math.hypot(nx, ny, nz);
    out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
    return out;
  }

  // odcinek tunelu obejmujący punkt (x,z,y): { s, t, u, floor } albo null.
  // u – odchylenie w lewo od osi (dodatnie = lewa ściana).
  function findTunnel(x, z, y) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const fx = x - cx * CHUNK, fz = z - cz * CHUNK;
    const m = 8;
    const ax = fx < m ? -1 : 0, bx = fx > CHUNK - m ? 1 : 0, az = fz < m ? -1 : 0, bz = fz > CHUNK - m ? 1 : 0;
    let best = null, bd = Infinity;
    for (let dz = az; dz <= bz; dz++) {
      for (let dx = ax; dx <= bx; dx++) {
        const list = roadSegs.get((cx + dx) + ',' + (cz + dz));
        if (!list) continue;
        for (let q = 0; q < list.length; q++) {
          const s = list[q];
          if (!s.tun) continue;
          const abx = s.bx - s.ax, abz = s.bz - s.az;
          let t = ((x - s.ax) * abx + (z - s.az) * abz) / (abx * abx + abz * abz || 1);
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = x - (s.ax + abx * t), qz = z - (s.az + abz * t);
          const d2 = qx * qx + qz * qz;
          if (d2 >= bd || d2 > 36) continue;
          const floor = s.ay + (s.by - s.ay) * t;
          if (y < floor - 1.5 || y > floor + TUN_H + 1.0) continue;
          bd = d2;
          best = { s, t, u: qx * s.px + qz * s.pz, floor };
        }
      }
    }
    return best;
  }

  // wysokość sklepienia nad punktem o odchyleniu u od osi
  function tunnelCeil(u, floor) {
    const k = clamp(u / TUN_HALF_W, -1, 1);
    return floor + TUN_WALL_H + TUN_ARCH_H * Math.sqrt(1 - k * k);
  }

  // ======================= GRACZ =======================
  const player = {
    pos: new THREE.Vector3(0, 0, 0),
    vel: new THREE.Vector3(),
    yaw: 0,
    pitch: -0.15,
    flying: false,
    onGround: false
  };

  const keys = {};
  let lastSpaceTap = 0;

  function setFlying(on) {
    player.flying = on;
    if (on) player.vel.y = 0;
  }

  // teleport w powietrze przed najbliższe miasto
  function teleportToCity() {
    const n = nearestCity(player.pos.x, player.pos.z);
    if (!n) return;
    const c = n.city;
    player.pos.set(c.x, c.h + 120, c.z + c.r * 1.5);
    player.yaw = 0;
    player.pitch = -0.3;
    player.vel.set(0, 0, 0);
    setFlying(true);
    invalidateChunks();
    updateChunks(400);
  }

  // ściany budynków: wypychanie na boki (dachy obsługuje surfaceAt)
  function resolveBuildingWalls(prevY) {
    const R = 0.45, STEP = 0.45;
    const bottom = Math.max(prevY, player.pos.y) - (player.flying ? 0.6 : EYE_HEIGHT);
    const pcx = Math.floor(player.pos.x / CHUNK), pcz = Math.floor(player.pos.z / CHUNK);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = buildBoxes.get((pcx + dx) + ',' + (pcz + dz));
        if (!list) continue;
        for (const b of list) {
          const x = player.pos.x, z = player.pos.z;
          if (x <= b.x0 - R || x >= b.x1 + R || z <= b.z0 - R || z >= b.z1 + R) continue;
          if (bottom >= b.top - STEP) continue;   // stoimy na dachu
          const l = x - (b.x0 - R), r = (b.x1 + R) - x, f = z - (b.z0 - R), k = (b.z1 + R) - z;
          const m = Math.min(l, r, f, k);
          if (m === l) { player.pos.x = b.x0 - R; player.vel.x = Math.min(player.vel.x, 0); }
          else if (m === r) { player.pos.x = b.x1 + R; player.vel.x = Math.max(player.vel.x, 0); }
          else if (m === f) { player.pos.z = b.z0 - R; player.vel.z = Math.min(player.vel.z, 0); }
          else { player.pos.z = b.z1 + R; player.vel.z = Math.max(player.vel.z, 0); }
        }
      }
    }
  }

  // ściany i sklepienie tunelu
  function constrainPlayerInTunnel(feetY) {
    const f = findTunnel(player.pos.x, player.pos.z, feetY);
    if (!f) return;
    const lim = TUN_HALF_W - 0.4;
    const au = Math.abs(f.u);
    if (au > lim) {
      const sg = f.u > 0 ? 1 : -1, over = au - lim;
      player.pos.x -= sg * over * f.s.px;
      player.pos.z -= sg * over * f.s.pz;
      const vn = (player.vel.x * f.s.px + player.vel.z * f.s.pz) * sg;
      if (vn > 0) { player.vel.x -= vn * sg * f.s.px; player.vel.z -= vn * sg * f.s.pz; }
    }
    const ceil = tunnelCeil(clamp(f.u, -lim, lim), f.floor) - 0.25;
    if (player.pos.y > ceil) { player.pos.y = ceil; if (player.vel.y > 0) player.vel.y = 0; }
  }

  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _wish = new THREE.Vector3();

  function updatePlayer(dt) {
    const sprint = keys.ShiftLeft || keys.ShiftRight;
    const fwdInput = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    const rightInput = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);

    const sinY = Math.sin(player.yaw), cosY = Math.cos(player.yaw);
    _right.set(cosY, 0, -sinY);

    if (player.flying) {
      const cp = Math.cos(player.pitch), sp = Math.sin(player.pitch);
      _fwd.set(-sinY * cp, sp, -cosY * cp);   // kierunek lotu zgodny ze spojrzeniem
    } else {
      _fwd.set(-sinY, 0, -cosY);
    }

    _wish.set(0, 0, 0).addScaledVector(_fwd, fwdInput).addScaledVector(_right, rightInput);
    if (player.flying) _wish.y += (keys.Space ? 1 : 0) - (keys.KeyC ? 1 : 0);
    if (_wish.lengthSq() > 0) _wish.normalize();

    const prevY = player.pos.y;
    const feetRef = prevY - (player.flying ? 0.6 : EYE_HEIGHT);
    const ground = surfaceAt(player.pos.x, player.pos.z, feetRef);
    const inWater = !player.flying && ground < WATER_LEVEL - 0.4 && player.pos.y - EYE_HEIGHT < WATER_LEVEL;

    let speed;
    if (player.flying) speed = sprint ? FLY_FAST_SPEED : FLY_SPEED;
    else speed = sprint ? SPRINT_SPEED : WALK_SPEED;
    if (inWater) speed *= 0.55;

    const smooth = Math.min(1, dt * (player.flying ? 6 : 12));
    player.vel.x += (_wish.x * speed - player.vel.x) * smooth;
    player.vel.z += (_wish.z * speed - player.vel.z) * smooth;

    if (player.flying) {
      player.vel.y += (_wish.y * speed - player.vel.y) * smooth;
    } else {
      player.vel.y -= GRAVITY * dt * (inWater ? 0.4 : 1);
      if (keys.Space && player.onGround) { player.vel.y = JUMP_SPEED; player.onGround = false; }
      if (inWater && keys.Space) player.vel.y = Math.max(player.vel.y, 4);   // pływanie w górę
    }

    player.pos.addScaledVector(player.vel, dt);
    resolveBuildingWalls(prevY);

    const ref2 = Math.max(prevY, player.pos.y) - (player.flying ? 0.6 : EYE_HEIGHT);
    constrainPlayerInTunnel(ref2);
    const gh = surfaceAt(player.pos.x, player.pos.z, ref2);
    if (player.flying) {
      const minY = gh + 0.6;
      if (player.pos.y < minY) { player.pos.y = minY; if (player.vel.y < 0) player.vel.y = 0; }
    } else {
      const feetTarget = gh + EYE_HEIGHT;
      if (player.pos.y <= feetTarget) {
        player.pos.y = feetTarget;
        if (player.vel.y < 0) player.vel.y = 0;
        player.onGround = true;
      } else {
        player.onGround = false;
      }
    }
  }

  // ======================= MATEMATYKA BRYŁY SZTYWNEJ (tablice [x,y,z], kwaterniony [x,y,z,w]) =======================
  const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const vSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const vScale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const vCross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const vLen = a => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  const vNorm = a => { const l = vLen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  // obrót wektora kwaternionem
  function qRot(q, v) {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const tx = 2 * (qy * v[2] - qz * v[1]);
    const ty = 2 * (qz * v[0] - qx * v[2]);
    const tz = 2 * (qx * v[1] - qy * v[0]);
    return [
      v[0] + qw * tx + (qy * tz - qz * ty),
      v[1] + qw * ty + (qz * tx - qx * tz),
      v[2] + qw * tz + (qx * ty - qy * tx)
    ];
  }
  const qInvRot = (q, v) => qRot([-q[0], -q[1], -q[2], q[3]], v);

  // całkowanie orientacji dla prędkości kątowej w układzie świata
  function qIntegrate(q, w, dt) {
    const hx = w[0] * 0.5 * dt, hy = w[1] * 0.5 * dt, hz = w[2] * 0.5 * dt;
    const nx = q[0] + (hx * q[3] + hy * q[2] - hz * q[1]);
    const ny = q[1] + (hy * q[3] + hz * q[0] - hx * q[2]);
    const nz = q[2] + (hz * q[3] + hx * q[1] - hy * q[0]);
    const nw = q[3] + (-(hx * q[0] + hy * q[1] + hz * q[2]));
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw) || 1;
    q[0] = nx / l; q[1] = ny / l; q[2] = nz / l; q[3] = nw / l;
  }

  const qFromYaw = yaw => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];

  // ======================= SAMOCHÓD – FIZYKA (bryła sztywna + zawieszenie + opony) =======================
  // Układ bryły: x = w prawo, y = w górę, z = do tyłu (przód auta to -z). Oś pochylenia = x, odchylenia = y, przechyłu = z.
  const CAR = {
    MASS: 1350, IX: 2200, IY: 2450, IZ: 720,
    WHEEL_R: 0.36, WHEEL_I: 1.6,
    //            lewy przód         prawy przód       lewy tył          prawy tył
    ATTACH: [[-0.86, -0.05, -1.40], [0.86, -0.05, -1.40], [-0.86, -0.05, 1.45], [0.86, -0.05, 1.45]],
    SUS_NAT: 0.30, SUS_MAX: 0.46, SUS_MIN: 0.03,          // długość swobodna, maks. rozciągnięcie, początek odbojnika
    SPRING: [30000, 30000, 28000, 28000], DAMP_COMP: 2600, DAMP_REB: 3600, ARB: [14000, 9000],
    HALF_W: 0.95, HALF_L: 2.15,
    HULL: [],                                             // punkty obrysu do kontaktu z podłożem (uzupełniane niżej)
    GEARS: [3.62, 2.19, 1.54, 1.14, 0.92, 0.76], REVERSE: 3.4, FINAL: 3.9, EFF: 0.9,
    IDLE: 900, REDLINE: 7200,
    CDA: 0.95, CLA: 0.5, RHO: 1.2,
    BRAKE_F: 1750, BRAKE_R: 1050, HAND: 3300,
    KAPPA_PEAK: 0.12, TANA_PEAK: 0.16,
    ENTER_DIST: 7
  };
  // współczynniki indeksowane stałymi SURF_GRASS=0, SURF_ROAD=1, SURF_SAND=2, SURF_SNOW=3
  const MU_BY_SURF = [0.72, 1.12, 0.55, 0.42];
  const CRR_BY_SURF = [0.045, 0.012, 0.11, 0.055];
  for (const y of [-0.21, 0.98]) for (const x of [-1, 1]) for (const z of [-1, 1]) CAR.HULL.push([x * CAR.HALF_W, y, z * CAR.HALF_L]);

  const RPM_PTS = [0, 1000, 2000, 3000, 4500, 5500, 6500, 7200, 7600];
  const TRQ_PTS = [120, 200, 290, 330, 350, 340, 300, 240, 0];
  function engineTorque(rpm) {
    if (rpm <= RPM_PTS[0]) return TRQ_PTS[0];
    for (let i = 1; i < RPM_PTS.length; i++) {
      if (rpm <= RPM_PTS[i]) return lerp(TRQ_PTS[i - 1], TRQ_PTS[i], (rpm - RPM_PTS[i - 1]) / (RPM_PTS[i] - RPM_PTS[i - 1]));
    }
    return 0;
  }

  const car = {
    p: [0, 1, 0], q: [0, 0, 0, 1], v: [0, 0, 0], w: [0, 0, 0],
    wheels: [], group: null,
    steer: 0, steerAngle: 0,
    thr: 0, brk: 0, hand: 0,
    gear: 1, shiftT: 0, rpm: CAR.IDLE,
    nitro: 1, nitroOn: false,
    speed: 0, heading: 0, pitchAng: 0, rollAng: 0,
    absActive: false, tcActive: false,
    driving: false, view: 'chase',
    look: { yaw: 0, pitch: 0, idle: 0 }, camHeading: 0,
    camPos: null,
    shake: 0, hint: '', hintT: 0,
    inWater: false, inTunnel: false, wheelsOnGround: 0, flipT: 0
  };
  for (let i = 0; i < 4; i++) {
    car.wheels.push({
      front: i < 2, driven: i >= 2, omega: 0, spin: 0, ls: CAR.SUS_NAT * 0.65,
      contact: false, kappa: 0, A: [0, 0, 0], surf: 0, Fz: 0
    });
  }

  const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  const carBasis = () => ({ right: qRot(car.q, [1, 0, 0]), up: qRot(car.q, [0, 1, 0]), fwd: qRot(car.q, [0, 0, -1]) });

  function ratioOfGear(g) {
    if (g > 0) return CAR.GEARS[g - 1] * CAR.FINAL;
    if (g < 0) return -CAR.REVERSE * CAR.FINAL;
    return 0;
  }

  // ---- sterowanie na poziomie klatki: skrzynia, kierownica, pedały ----
  function updateCarControls(dt) {
    const drv = car.driving;
    const B = carBasis();
    const vf = vDot(car.v, B.fwd);
    const W = drv && !!keys.KeyW, S = drv && !!keys.KeyS;

    // kierunek jazdy (D/R) przy postoju
    if (settings.autoGear || car.gear < 0) {
      if (car.gear >= 0 && S && !W && vf < 1.0) car.gear = -1;
      else if (car.gear < 0 && W && !S && vf > -1.0) car.gear = 1;
    }
    const rev = car.gear < 0;
    const thrT = drv ? (rev ? (S ? 1 : 0) : (W ? 1 : 0)) : 0;
    const brkT = drv ? (rev ? (W ? 1 : 0) : (S ? 1 : 0)) : 1;   // zaparkowane auto: pełny hamulec postojowy
    car.thr += (thrT - car.thr) * Math.min(1, dt * 9);
    car.brk += (brkT - car.brk) * Math.min(1, dt * 12);
    car.hand = drv ? (keys.Space ? 1 : 0) : 1;

    // nitro
    car.nitroOn = drv && !!(keys.ShiftLeft || keys.ShiftRight) && car.nitro > 0.02 && car.thr > 0.3 && car.gear > 0;
    car.nitro = clamp(car.nitro + (car.nitroOn ? -0.17 : 0.05) * dt, 0, 1);

    // automatyczna skrzynia
    car.shiftT = Math.max(0, car.shiftT - dt);
    if (settings.autoGear && car.gear > 0 && car.shiftT <= 0) {
      const wAvg = Math.abs(car.wheels[2].omega + car.wheels[3].omega) * 0.5;
      const rpm = wAvg * Math.abs(ratioOfGear(car.gear)) * 9.5493;
      if (rpm > 6300 && car.gear < 6) { car.gear++; car.shiftT = 0.28; }
      else if (car.gear > 1) {
        const lower = rpm * ratioOfGear(car.gear - 1) / ratioOfGear(car.gear);
        if ((rpm < 2100 && lower < 5800) || (car.thr > 0.85 && rpm < 3400 && lower < 5600)) { car.gear--; car.shiftT = 0.25; }
      }
    }

    // kierownica: ruch wygładzany, kąt kół maleje z prędkością
    const target = drv ? ((keys.KeyA ? 1 : 0) - (keys.KeyD ? 1 : 0)) : 0;
    const rate = target === 0 ? 10 : (Math.sign(target) === Math.sign(car.steer) || car.steer === 0 ? 5.5 : 12);
    car.steer += (target - car.steer) * Math.min(1, dt * rate);
    const av = Math.abs(vf);
    car.steerAngle = car.steer * Math.max(0.07, 0.62 / (1 + (av / 20) * (av / 20)));
  }

  function manualShift(dir) {
    if (settings.autoGear || !car.driving) return;
    if (car.shiftT > 0) return;
    const g = car.gear + dir;
    if (g >= 1 && g <= 6) { car.gear = g; car.shiftT = 0.2; }
  }

  // ---- jeden krok całkowania ----
  const _nbuf = [0, 1, 0];
  function carSubstep(dt) {
    const m = CAR.MASS, p = car.p, q = car.q, v = car.v;
    let w = car.w;
    const right = qRot(q, [1, 0, 0]), up = qRot(q, [0, 1, 0]), fwd = qRot(q, [0, 0, -1]);
    const vf = vDot(v, fwd);
    const F = [0, -m * 9.81, 0], T = [0, 0, 0];
    const forceAt = (f, pt) => {
      F[0] += f[0]; F[1] += f[1]; F[2] += f[2];
      const r = vSub(pt, p), t = vCross(r, f);
      T[0] += t[0]; T[1] += t[1]; T[2] += t[2];
    };
    const invI = t => {   // I^-1 * t w układzie świata
      const b = qInvRot(q, t);
      return qRot(q, [b[0] / CAR.IX, b[1] / CAR.IY, b[2] / CAR.IZ]);
    };
    const impulse = (r, J) => {
      v[0] += J[0] / m; v[1] += J[1] / m; v[2] += J[2] / m;
      const dw = invI(vCross(r, J));
      w[0] += dw[0]; w[1] += dw[1]; w[2] += dw[2];
    };
    // impuls kontaktu (normalny + tarcie); zwraca wielkość impulsu normalnego
    const contactImpulse = (r, n, e, mu) => {
      const vr = vAdd(v, vCross(w, r));
      const vn = vDot(vr, n);
      if (vn >= 0) return 0;
      const kn = 1 / m + vDot(vCross(invI(vCross(r, n)), r), n);
      const j = -(1 + e) * vn / kn;
      const vt = vSub(vr, vScale(n, vn)), vtl = vLen(vt);
      impulse(r, vScale(n, j));
      if (vtl > 1e-3) {
        const td = vScale(vt, 1 / vtl);
        const kt = 1 / m + vDot(vCross(invI(vCross(r, td)), r), td);
        impulse(r, vScale(td, -Math.min(mu * j, vtl / kt)));
      }
      return j;
    };

    // opór powietrza, docisk aerodynamiczny
    const vl = vLen(v);
    if (vl > 0.01) {
      const k = 0.5 * CAR.RHO * CAR.CDA * vl;
      F[0] -= k * v[0]; F[1] -= k * v[1]; F[2] -= k * v[2];
      F[1] -= 0.5 * CAR.RHO * CAR.CLA * vl * vl * 0.5;
    }
    // woda: wypór i opór
    const depth = WATER_LEVEL + 0.2 - p[1];
    car.inWater = depth > 0;
    if (car.inWater) {
      F[1] += Math.min(45000, 16000 * depth);
      F[0] -= 2600 * v[0]; F[1] -= 2600 * v[1]; F[2] -= 2600 * v[2];
    }

    // ---- zawieszenie: promień z każdego koła ----
    const wh = car.wheels;
    let contacts = 0;
    for (let i = 0; i < 4; i++) {
      const W = wh[i], A = vAdd(p, qRot(q, CAR.ATTACH[i]));
      W.A = A; W.contact = false; W.Fz = 0;
      let ls = CAR.SUS_MAX;
      if (up[1] > 0.12) {
        let x = A[0], z = A[2], gh = 0, L = 0;
        for (let it = 0; it < 2; it++) {
          gh = surfaceAt(x, z, A[1] - 0.15);
          L = (A[1] - gh) / up[1];
          x = A[0] - up[0] * L; z = A[2] - up[2] * L;
        }
        W.surf = surfKind;
        ls = L - CAR.WHEEL_R;
        if (L > -0.25 && ls < CAR.SUS_MAX) {
          W.contact = true;
          W.C = vSub(A, vScale(up, L));
          surfaceNormal(W.C[0], W.C[2], A[1] - 0.15, _nbuf);
          W.n = [_nbuf[0], _nbuf[1], _nbuf[2]];
          contacts++;
        }
      }
      W.lsRaw = Math.max(-0.3, Math.min(ls, CAR.SUS_MAX));
    }
    car.wheelsOnGround = contacts;

    // siły sprężyn + stabilizatory
    const comp = wh.map(W => CAR.SUS_NAT - W.lsRaw);
    for (let i = 0; i < 4; i++) {
      const W = wh[i];
      if (!W.contact) continue;
      const vA = vAdd(v, vCross(w, vSub(W.A, p)));
      const vd = -vDot(vA, up);
      let Fs = CAR.SPRING[i] * comp[i] + (vd > 0 ? CAR.DAMP_COMP : CAR.DAMP_REB) * vd;
      if (W.lsRaw < CAR.SUS_MIN) Fs += 220000 * (CAR.SUS_MIN - W.lsRaw);
      const pair = i < 2 ? 0 : 1, other = i ^ 1, k = CAR.ARB[pair];
      Fs += k * (comp[i] - comp[other]);
      W.Fz = Math.max(0, Fs);
    }

    // ---- napęd i hamulce ----
    const ratio = ratioOfGear(car.gear);
    const wDrv = (wh[2].omega + wh[3].omega) * 0.5;
    const rpmWheel = Math.abs(wDrv) * Math.abs(ratio) * 9.5493;
    let Twheel = 0;
    if (ratio !== 0 && car.shiftT <= 0.08) {
      const rpmE = Math.max(rpmWheel, 1600);
      let Te = engineTorque(rpmE) * car.thr;
      if (car.thr < 0.03 && rpmWheel > 1300) Te = -(30 + rpmWheel * 0.012);       // hamowanie silnikiem
      if (rpmWheel > CAR.REDLINE) Te *= clamp((7600 - rpmWheel) / 400, 0, 1);       // ogranicznik obrotów
      if (car.nitroOn && Te > 0) Te *= 1.35;
      if (Te > 0 && settings.assists) {                                             // kontrola trakcji
        const kmax = Math.max(wh[2].kappa, wh[3].kappa), kavg = (wh[2].kappa + wh[3].kappa) * 0.5;
        const f = clamp(1 - (0.6 * kmax + 0.4 * kavg - 0.13) * 11, 0.04, 1);   // trzymaj poślizg przy szczycie (buksowanie zabiera przyczepność boczną)
        car.tcActive = f < 0.99;
        Te *= f;
      } else car.tcActive = false;
      Twheel = Te * ratio * CAR.EFF * 0.5;       // po połowie na koło; różnicę obrotów ogranicza sprzęgło (LSD) niżej
    } else car.tcActive = false;
    const pedal = car.brk;
    // sprzęgło lepkie dyferencjału: przenosi moment z szybciej kręcącego się koła na wolniejsze
    const Tlsd = clamp(110 * (wh[2].omega - wh[3].omega), -600, 600);

    // ---- opony ----
    car.absActive = false;
    for (let i = 0; i < 4; i++) {
      const W = wh[i];
      const R = CAR.WHEEL_R, Iw = CAR.WHEEL_I;
      let om = W.omega + (W.driven ? Twheel - (i === 2 ? Tlsd : -Tlsd) : 0) / Iw * dt;
      let Tb = W.front ? CAR.BRAKE_F * pedal : Math.max(CAR.BRAKE_R * pedal, CAR.HAND * car.hand);
      if (settings.assists && pedal > 0.05 && W.kappa < -0.2 && !(car.hand > 0.5 && !W.front)) { Tb *= 0.25; car.absActive = true; }
      const dB = Tb / Iw * dt;
      om = Math.abs(om) <= dB ? 0 : om - Math.sign(om) * dB;

      if (!W.contact) { W.omega = om * (1 - 0.1 * dt); W.kappa = 0; continue; }

      const n = W.n, C = W.C;
      const steer = W.front ? car.steerAngle : 0;
      let f = qRot(q, [-Math.sin(steer), 0, -Math.cos(steer)]);
      f = vNorm(vSub(f, vScale(n, vDot(f, n))));
      const sd = vCross(f, n);                       // w prawo
      const rC = vSub(C, p);
      const vC = vAdd(v, vCross(w, rC));
      const vfw = vDot(vC, f), vsw = vDot(vC, sd);
      const vden = Math.max(Math.abs(vfw), 2.5);
      const kappa = (om * R - vfw) / vden;
      const sx = kappa / CAR.KAPPA_PEAK, sy = (vsw / vden) / CAR.TANA_PEAK;
      const s = Math.hypot(sx, sy);
      const Fmax = MU_BY_SURF[W.surf] * W.Fz;
      let Fx = 0, Fy = 0;
      if (s > 1e-6) {
        const D = s < 1 ? Math.sin(Math.PI / 2 * s) : 0.78 + 0.22 / s;   // szczyt przyczepności, potem poślizg
        Fx = D * Fmax * sx / s;
        Fy = -D * Fmax * sy / s;
      }
      // stabilność: siła nie może „przeskoczyć” poślizgu w jednym kroku
      const FxLim = Iw * Math.abs(om * R - vfw) / (R * R * dt) + 1;
      Fx = clamp(Fx, -FxLim, FxLim);
      W.omega = om - Fx * R / Iw * dt;
      W.kappa = (W.omega * R - vfw) / vden;      // poślizg PO uwzględnieniu siły tarcia – na nim działają TCS i ABS

      // opory toczenia
      const Frr = -CRR_BY_SURF[W.surf] * W.Fz * Math.tanh(vfw / 1.0);
      forceAt(vAdd(vScale(f, Fx + Frr), vScale(sd, Fy)), C);
      // sprężyna działa wzdłuż osi zawieszenia w punkcie zamocowania
      forceAt(vScale(up, W.Fz), W.A);
    }

    // ---- obrys auta o podłoże (przewracanie, uderzenia) ----
    for (const hp of CAR.HULL) {
      const P = vAdd(p, qRot(q, hp));
      const gh = surfaceAt(P[0], P[2], P[1] + 0.3);
      const dep = gh - P[1];
      if (dep <= 0 || dep > 2.5) continue;
      const n = surfaceNormal(P[0], P[2], P[1] + 0.3, [0, 1, 0]);
      const r = vSub(P, p), vP = vAdd(v, vCross(w, r));
      const vn = vDot(vP, n);
      const Fn = Math.min(140000, Math.max(0, 90000 * dep - 5500 * vn));
      const vt = vSub(vP, vScale(n, vn)), vtl = vLen(vt);
      forceAt(vAdd(vScale(n, Fn), vScale(vt, -0.55 * Fn / (vtl + 0.6))), P);
    }

    // ---- całkowanie ruchu ----
    v[0] += F[0] / m * dt; v[1] += F[1] / m * dt; v[2] += F[2] / m * dt;
    const wb = qInvRot(q, w), Tb2 = qInvRot(q, T);
    const Ib = [CAR.IX, CAR.IY, CAR.IZ];
    const Iwb = [Ib[0] * wb[0], Ib[1] * wb[1], Ib[2] * wb[2]];
    const gyro = vCross(wb, Iwb);
    for (let k = 0; k < 3; k++) wb[k] += (Tb2[k] - gyro[k]) / Ib[k] * dt;
    const wn = qRot(q, wb);
    w[0] = wn[0] * (1 - 0.1 * dt); w[1] = wn[1] * (1 - 0.1 * dt); w[2] = wn[2] * (1 - 0.1 * dt);
    const wl = vLen(w);
    if (wl > 30) { w[0] *= 30 / wl; w[1] *= 30 / wl; w[2] *= 30 / wl; }
    qIntegrate(q, w, dt);
    p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt;

    // ---- twarde przeszkody: budynki, drzewa, ściany tunelu ----
    collideStatics(contactImpulse, fwd, right);

    // ---- zabezpieczenie przed wpadnięciem pod świat ----
    const sg = surfaceAt(p[0], p[2], p[1]);
    if (p[1] < sg - 1.2) { p[1] = sg + 0.8; v[1] = Math.max(v[1], 0); }

    // zaparkowane auto stoi nieruchomo (statyczne tarcie)
    if (!car.driving && contacts === 4 && vLen(v) < 0.18 && vLen(w) < 0.12) {
      v[0] = v[1] = v[2] = 0; w[0] = w[1] = w[2] = 0;
    }
  }

  function carPlanFrame(fwd, right) {
    let fx = fwd[0], fz = fwd[2], l = Math.hypot(fx, fz);
    if (l < 0.3) { fx = -right[2]; fz = right[0]; l = Math.hypot(fx, fz) || 1; }
    fx /= l; fz /= l;
    let rx = right[0], rz = right[2]; const rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    return { fx, fz, rx, rz };
  }

  function satBox(b, cor, fr) {
    const axes = [[1, 0], [0, 1], [fr.fx, fr.fz], [fr.rx, fr.rz]];
    const bcorn = [[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]];
    let best = null;
    for (let ai = 0; ai < 4; ai++) {
      const ax = axes[ai][0], az = axes[ai][1];
      let cmin = Infinity, cmax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const c of cor) { const d = c[0] * ax + c[1] * az; if (d < cmin) cmin = d; if (d > cmax) cmax = d; }
      for (const c of bcorn) { const d = c[0] * ax + c[1] * az; if (d < bmin) bmin = d; if (d > bmax) bmax = d; }
      const o1 = cmax - bmin, o2 = bmax - cmin;
      if (o1 <= 0 || o2 <= 0) return null;
      const ov = Math.min(o1, o2);
      if (!best || ov < best.pen) { const sg = o1 < o2 ? -1 : 1; best = { pen: ov, nx: ax * sg, nz: az * sg, axis: ai }; }
    }
    let cp = null, bestD = Infinity;
    if (best.axis < 2) {
      for (const c of cor) { const d = c[0] * best.nx + c[1] * best.nz; if (d < bestD) { bestD = d; cp = c; } }
    } else {
      bestD = -Infinity;
      for (const c of bcorn) { const d = c[0] * best.nx + c[1] * best.nz; if (d > bestD) { bestD = d; cp = c; } }
    }
    best.cp = cp;
    return best;
  }

  function collideStatics(contactImpulse, fwd, right) {
    const p = car.p, v = car.v, fr = carPlanFrame(fwd, right);
    const hx = CAR.HALF_W, hz = CAR.HALF_L;
    const cor = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      cor.push([p[0] + fr.fx * sz * hz + fr.rx * sx * hx, p[2] + fr.fz * sz * hz + fr.rz * sx * hx]);
    }
    let hit = 0;

    // budynki
    const pcx = Math.floor(p[0] / CHUNK), pcz = Math.floor(p[2] / CHUNK);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = buildBoxes.get((pcx + dx) + ',' + (pcz + dz));
        if (!list) continue;
        for (const b of list) {
          if (p[0] < b.x0 - 4 || p[0] > b.x1 + 4 || p[2] < b.z0 - 4 || p[2] > b.z1 + 4) continue;
          if (p[1] - 0.3 >= b.top - 0.05) continue;     // jedziemy po dachu
          const c = satBox(b, cor, fr);
          if (!c) continue;
          p[0] += c.nx * c.pen * 0.9; p[2] += c.nz * c.pen * 0.9;
          const j = contactImpulse([c.cp[0] - p[0], -0.15, c.cp[1] - p[2]], [c.nx, 0, c.nz], 0.2, 0.35);
          if (j > hit) hit = j;
          for (const k of cor) { k[0] += c.nx * c.pen * 0.9; k[1] += c.nz * c.pen * 0.9; }
        }
      }
    }

    // drzewa (pnie jako walce)
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tr = treeSolids.get((pcx + dx) + ',' + (pcz + dz));
        if (!tr) continue;
        for (let q = 0; q < tr.length; q += 3) {
          const tx = tr[q], tz = tr[q + 1], rr = tr[q + 2] + 0.05;
          const ddx = tx - p[0], ddz = tz - p[2];
          if (ddx * ddx + ddz * ddz > 16) continue;
          const lf = ddx * fr.fx + ddz * fr.fz, lr = ddx * fr.rx + ddz * fr.rz;
          const cf = clamp(lf, -hz, hz), cr = clamp(lr, -hx, hx);
          let ex = lf - cf, ez = lr - cr, d = Math.hypot(ex, ez);
          if (d >= rr || d < 1e-6) continue;
          if (p[1] - 0.4 > getHeight(tx, tz) + 2.4) continue;   // przelatujemy nad drzewem
          ex /= d; ez /= d;
          const nx = -(ex * fr.fx + ez * fr.rx), nz = -(ex * fr.fz + ez * fr.rz);   // od drzewa do auta
          const pen = rr - d;
          p[0] += nx * pen * 0.9; p[2] += nz * pen * 0.9;
          const cpx = p[0] + fr.fx * cf + fr.rx * cr, cpz = p[2] + fr.fz * cf + fr.rz * cr;
          const j = contactImpulse([cpx - p[0], -0.15, cpz - p[2]], [nx, 0, nz], 0.1, 0.3);
          if (j > hit) hit = j;
        }
      }
    }

    // ściany tunelu
    const tf = findTunnel(p[0], p[2], p[1]);
    car.inTunnel = !!tf;
    if (tf) {
      const lim = TUN_HALF_W - 0.05, s = tf.s;
      for (const c of cor) {
        const u = tf.u + (c[0] - p[0]) * s.px + (c[1] - p[2]) * s.pz;
        const au = Math.abs(u);
        if (au <= lim) continue;
        const sg = u > 0 ? 1 : -1, pen = au - lim;
        const nx = -sg * s.px, nz = -sg * s.pz;
        p[0] += nx * pen * 0.9; p[2] += nz * pen * 0.9;
        const j = contactImpulse([c[0] - p[0], -0.15, c[1] - p[2]], [nx, 0, nz], 0.15, 0.3);
        if (j > hit) hit = j;
      }
    }
    if (hit > 0) car.shake = Math.max(car.shake, Math.min(0.7, hit / CAR.MASS / 10));
  }

  // ---- krok na poziomie klatki: stały podkrok fizyki ----
  const PHYS_DT = 1 / 120;
  let physAcc = 0;
  function updateCar(dt) {
    updateCarControls(dt);
    physAcc = Math.min(physAcc + dt, PHYS_DT * 8);
    while (physAcc >= PHYS_DT) { carSubstep(PHYS_DT); physAcc -= PHYS_DT; }

    const B = carBasis();
    const vf = vDot(car.v, B.fwd);
    car.speed = vf;
    car.heading = Math.atan2(-B.fwd[0], -B.fwd[2]);
    car.pitchAng = Math.asin(clamp(B.fwd[1], -1, 1));
    car.rollAng = Math.asin(clamp(B.right[1], -1, 1));
    const wAvg = Math.abs(car.wheels[2].omega + car.wheels[3].omega) * 0.5;
    const rpmT = Math.max(CAR.IDLE + car.thr * 500, wAvg * Math.abs(ratioOfGear(car.gear)) * 9.5493);
    car.rpm += (clamp(rpmT, CAR.IDLE, CAR.REDLINE + 300) - car.rpm) * Math.min(1, dt * 14);
    car.shake *= Math.exp(-dt * 5);
    car.hintT -= dt;
    // wywrócone auto: podpowiedź i możliwość postawienia na koła
    car.flipT = B.up[1] < 0.25 && vLen(car.v) < 3 ? car.flipT + dt : 0;

    // wizualne zawieszenie: wygładzona długość i obrót kół
    for (let i = 0; i < 4; i++) {
      const W = car.wheels[i];
      const target = W.contact ? clamp(W.lsRaw, 0, CAR.SUS_MAX) : CAR.SUS_MAX;
      W.ls += (target - W.ls) * Math.min(1, dt * (W.contact ? 30 : 8));
      W.spin += W.omega * dt;
    }
    syncCarModel();
  }

  // macierz obrotu (kolumny: prawo, góra, tył) → kwaternion
  function qFromBasis(r, u, b) {
    const m00 = r[0], m10 = r[1], m20 = r[2], m01 = u[0], m11 = u[1], m21 = u[2], m02 = b[0], m12 = b[1], m22 = b[2];
    const tr = m00 + m11 + m22;
    let q;
    if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / S, (m02 - m20) / S, (m10 - m01) / S, 0.25 * S]; }
    else if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * S, (m01 + m10) / S, (m02 + m20) / S, (m21 - m12) / S]; }
    else if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / S, 0.25 * S, (m12 + m21) / S, (m02 - m20) / S]; }
    else { const S = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / S, (m12 + m21) / S, 0.25 * S, (m10 - m01) / S]; }
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }

  // pozycja i pochylenie auta dopasowane do podłoża (nie wbija kół w zbocze)
  function groundPose(x, z, heading, refY) {
    const fx = -Math.sin(heading), fz = -Math.cos(heading), rx = -fz, rz = fx;   // poziomo: przód i prawo
    const g = (a, b) => surfaceAt(x + fx * a + rx * b, z + fz * a + rz * b, refY);
    const hf = g(1.5, 0), hb = g(-1.5, 0), hr = g(0, 1.0), hl = g(0, -1.0), hc = g(0, 0);
    const a = (hf - hb) / 3.0, bb = (hr - hl) / 2.0;
    let n = [-(a * fx + bb * rx), 1, -(a * fz + bb * rz)];
    n = vNorm(n);
    const f0 = [fx, 0, fz];
    const fwd = vNorm(vSub(f0, vScale(n, vDot(f0, n))));
    const right = vCross(fwd, n);
    const hmax = Math.max(hf, hb, hr, hl, hc), hmin = Math.min(hf, hb, hr, hl, hc);
    return { y: hmax, rough: hmax - hmin, q: qFromBasis(right, n, vScale(fwd, -1)) };
  }

  // równe miejsce na auto w pobliżu gracza (najpierw tuż za nim, potem coraz dalej dookoła)
  function findCarSpot(px, pz, yaw, refY) {
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    let best = null;
    for (let k = 0; k < 40; k++) {
      let ox, oz;
      if (k === 0) { ox = 3.2; oz = 5.5; }
      else { const a = k * 2.399963, r = 5 + (k % 4) * 1.5 + k * 0.12; ox = Math.cos(a) * r; oz = Math.sin(a) * r; }
      const x = px + cy * ox + sy * oz, z = pz - sy * ox + cy * oz;
      const rough = groundPose(x, z, yaw + 0.5, refY).rough;
      if (!best || rough < best.rough) best = { x, z, rough };
      if (rough < 0.35) break;
    }
    return best;
  }

  function placeCar(x, z, heading, refY) {
    const pose = groundPose(x, z, heading, refY === undefined ? 1e9 : refY);
    car.p = [x, pose.y + 0.72, z];
    car.q = pose.q;
    car.v = [0, 0, 0]; car.w = [0, 0, 0];
    car.steer = 0; car.steerAngle = 0; car.thr = 0; car.brk = 0; car.gear = 1; car.shiftT = 0;
    car.shake = 0; car.flipT = 0; car.nitro = 1;
    for (const W of car.wheels) { W.omega = 0; W.kappa = 0; W.ls = CAR.SUS_NAT * 0.63; W.contact = false; }
    physAcc = 0;
    car.camHeading = heading;
    syncCarModel();
  }

  // postawienie wywróconego auta na koła w tym samym miejscu
  function flipCarUpright() {
    const yaw = car.heading;
    const pose = groundPose(car.p[0], car.p[2], yaw, car.p[1] + 3);
    car.q = pose.q;
    car.v = [0, 0, 0]; car.w = [0, 0, 0];
    car.p[1] = pose.y + 0.85;
  }

  // ======================= SAMOCHÓD – MODEL, KAMERA, WSIADANIE =======================
  // Model złożony z prostych brył; przód auta wskazuje -Z. Kółka są osobnymi węzłami (zawieszenie je przesuwa).
  const carTailMat = new THREE.MeshBasicMaterial({ color: 0x8f1414 });
  const carWheelNodes = [];
  let carHeadLight = null;

  function buildCarModel() {
    const g = new THREE.Group();
    const body = new THREE.Group();
    body.position.set(0, -0.59, 0);     // podłoga modelu względem środka masy (przy statycznym ugięciu zawieszenia)
    g.add(body);
    const paint = new THREE.MeshPhongMaterial({ color: 0xc0392b, shininess: 90, specular: 0x777777 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x15181c });
    const glass = new THREE.MeshPhongMaterial({ color: 0x1d2a38, shininess: 120, specular: 0x9ab8d8 });
    const chrome = new THREE.MeshLambertMaterial({ color: 0xc4c8ce });
    const headMat = new THREE.MeshBasicMaterial({ color: 0xfff3c4 });

    const box = (w, h, l, mat, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat);
      m.position.set(x, y, z);
      body.add(m);
    };
    box(1.9, 0.62, 4.3, paint, 0, 0.68, 0);            // karoseria
    box(1.62, 0.55, 2.05, glass, 0, 1.27, 0.25);       // kabina (szyby)
    box(1.72, 0.08, 1.75, paint, 0, 1.58, 0.25);       // dach
    box(1.96, 0.22, 0.22, dark, 0, 0.5, -2.2);         // zderzak przedni
    box(1.96, 0.22, 0.22, dark, 0, 0.5, 2.2);          // zderzak tylny
    box(1.0, 0.2, 0.05, dark, 0, 0.7, -2.16);          // atrapa chłodnicy
    box(1.7, 0.06, 0.4, dark, 0, 1.2, 2.0);            // spoiler
    box(0.06, 0.3, 0.1, dark, -0.6, 1.05, 2.0);
    box(0.06, 0.3, 0.1, dark, 0.6, 1.05, 2.0);
    for (const s of [-1, 1]) {
      box(0.4, 0.16, 0.06, headMat, s * 0.68, 0.8, -2.16);      // reflektory
      box(0.4, 0.16, 0.06, carTailMat, s * 0.68, 0.82, 2.16);   // światła tylne
      box(0.14, 0.1, 0.24, paint, s * 1.02, 1.05, -0.5);        // lusterka
    }

    const tireGeo = new THREE.CylinderGeometry(CAR.WHEEL_R, CAR.WHEEL_R, 0.3, 18);
    const hubGeo = new THREE.CylinderGeometry(0.21, 0.21, 0.32, 10);
    for (let i = 0; i < 4; i++) {
      const pivot = new THREE.Group();                 // skręt (oś Y) i położenie z zawieszenia
      const spin = new THREE.Group();                  // obrót wokół osi koła (oś X)
      const tire = new THREE.Mesh(tireGeo, dark);
      const hub = new THREE.Mesh(hubGeo, chrome);
      tire.rotation.z = hub.rotation.z = Math.PI / 2;
      spin.add(tire, hub);
      pivot.add(spin);
      g.add(pivot);
      carWheelNodes.push({ pivot, spin });
    }

    // reflektory (działają w nocy i w tunelu)
    carHeadLight = new THREE.SpotLight(0xfff0d0, 0, 150, 0.5, 0.55, 1.0);
    carHeadLight.position.set(0, 0.2, -2.2);
    const tgt = new THREE.Object3D();
    tgt.position.set(0, -0.6, -30);
    g.add(carHeadLight);
    g.add(tgt);
    carHeadLight.target = tgt;
    return g;
  }
  car.group = buildCarModel();
  scene.add(car.group);

  function syncCarModel() {
    const g = car.group;
    g.position.set(car.p[0], car.p[1], car.p[2]);
    g.quaternion.set(car.q[0], car.q[1], car.q[2], car.q[3]);
    for (let i = 0; i < 4; i++) {
      const a = CAR.ATTACH[i], W = car.wheels[i], n = carWheelNodes[i];
      n.pivot.position.set(a[0], a[1] - W.ls, a[2]);
      n.pivot.rotation.y = W.front ? car.steerAngle : 0;
      n.spin.rotation.x = W.spin;
    }
    carTailMat.color.setHex(car.brk > 0.1 || car.hand > 0.5 ? 0xff5a5a : 0x8f1414);
    const lamp = (car.driving ? 1 : 0) * Math.max(nightFactor, car.inTunnel ? 0.6 : 0);
    carHeadLight.intensity = lamp * 2.4;
  }

  // ---- wsiadanie / wysiadanie / przywołanie ----
  function callCar() {
    car.driving = false;
    const ref = player.pos.y - EYE_HEIGHT + 1.5;
    const sp = findCarSpot(player.pos.x, player.pos.z, player.yaw, ref);
    placeCar(sp.x, sp.z, player.yaw + 0.5, ref);
  }

  function enterCar() {
    car.driving = true;
    car.look.yaw = car.look.pitch = 0;
    car.look.idle = 99;
    car.camHeading = car.heading;
    car.camPos = null;
    player.flying = false;
    player.vel.set(0, 0, 0);
  }

  function exitCar() {
    const B = carBasis();
    const lx = car.p[0] - B.right[0] * 2.4, lz = car.p[2] - B.right[2] * 2.4;   // wysiadamy po lewej stronie
    player.pos.set(lx, surfaceAt(lx, lz, car.p[1]) + EYE_HEIGHT, lz);
    player.vel.set(0, 0, 0);
    player.yaw = car.heading;
    player.pitch = -0.1;
    player.onGround = true;
    car.driving = false;
    camera.fov = settings.fov;
    camera.updateProjectionMatrix();
  }

  function toggleCar() {
    if (car.driving) {
      if (Math.abs(car.speed) > 9) { car.hint = 'Zwolnij, aby wysiąść'; car.hintT = 2; return; }
      exitCar();
    } else {
      const d = Math.hypot(player.pos.x - car.p[0], player.pos.z - car.p[2]);
      if (d <= CAR.ENTER_DIST && Math.abs(player.pos.y - EYE_HEIGHT - car.p[1]) < 8) enterCar();
      else { car.hint = 'Za daleko od auta (G – przywołaj)'; car.hintT = 2; }
    }
  }

  // ---- kamera ----
  function updateCarCamera(dt) {
    const L = car.look;
    L.idle += dt;
    if (L.idle > 1.2) { const k = Math.exp(-dt * 2.5); L.yaw *= k; L.pitch *= k; }
    car.camHeading += angDiff(car.heading, car.camHeading) * Math.min(1, dt * 5);
    const sh = settings.shake ? car.shake : 0;
    const jx = (Math.random() - 0.5) * sh, jy = (Math.random() - 0.5) * sh;
    const B = carBasis();
    const px = car.p[0], py = car.p[1], pz = car.p[2];

    if (car.view === 'cockpit') {
      const eye = vAdd(car.p, qRot(car.q, [-0.4, 0.5, -0.15]));
      camera.position.set(eye[0] + jx, eye[1] + jy, eye[2]);
      camera.rotation.set(clamp(L.pitch + car.pitchAng * 0.5, -1.4, 1.4), car.heading + L.yaw, car.rollAng * 0.6);
    } else {
      const yaw = car.camHeading + L.yaw;
      const a = clamp(0.14 - L.pitch, -0.3, 1.2), D = 8.5 + Math.min(4, Math.abs(car.speed) * 0.05);
      const des = [
        px + Math.sin(yaw) * D * Math.cos(a),
        py + 1.5 + D * Math.sin(a),
        pz + Math.cos(yaw) * D * Math.cos(a)
      ];
      if (!car.camPos) car.camPos = des.slice();
      const k = Math.min(1, dt * 12);
      car.camPos[0] += (des[0] - car.camPos[0]) * k;
      car.camPos[1] += (des[1] - car.camPos[1]) * k;
      car.camPos[2] += (des[2] - car.camPos[2]) * k;
      let cx = car.camPos[0], cy = car.camPos[1], cz = car.camPos[2];

      // kamera nie wchodzi pod ziemię ani w ściany tunelu
      const tf = findTunnel(cx, cz, cy);
      if (tf) {
        const lim = TUN_HALF_W - 0.6, u = clamp(tf.u, -lim, lim);
        cx += (u - tf.u) * tf.s.px; cz += (u - tf.u) * tf.s.pz;
        cy = clamp(cy, tf.floor + 0.7, tunnelCeil(u, tf.floor) - 0.5);
      } else {
        const gmin = surfaceAt(cx, cz, Math.max(cy, py) + 1) + 0.7;
        if (cy < gmin && gmin < py + 6) cy = gmin;
      }
      camera.position.set(cx + jx, cy + jy, cz);
      camera.lookAt(px + B.fwd[0] * 2, py + 1.1, pz + B.fwd[2] * 2);
    }

    const fov = settings.fov + clamp(Math.abs(car.speed) * 0.22, 0, 14);   // im szybciej, tym szerszy kąt
    if (Math.abs(camera.fov - fov) > 0.1) {
      camera.fov += (fov - camera.fov) * Math.min(1, dt * 4);
      camera.updateProjectionMatrix();
    }
  }

  // ======================= MENU, HUD, WEJŚCIE =======================
  const $ = id => document.getElementById(id);
  const menuEl = $('menu'), hudEl = $('hud'), dashEl = $('dash'), toastEl = $('toast');
  const hudMode = $('hud-mode'), hudPos = $('hud-pos'), hudInfo = $('hud-info'), hudCity = $('hud-city'), hudCar = $('hud-car');
  let locked = false;
  let gameStarted = false;
  let gameHour = settings.timeOfDay;
  let toastTimer = 0;

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }

  const fmtHour = h => {
    const hh = Math.floor(h) % 24, mm = Math.floor((h - Math.floor(h)) * 60);
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  };
  const FORMATS = {
    mountainScale: v => '×' + (+v).toFixed(1),
    cityDensity: v => Math.round(v * 100) + '%',
    viewDist: v => v + ' chunków (' + v * CHUNK + ' m)',
    renderScale: v => Math.round(v * 100) + '%',
    fov: v => v + '°',
    timeOfDay: fmtHour,
    sens: v => (+v).toFixed(2) + '×'
  };

  // ---- powiązanie kontrolek z ustawieniami ----
  function refreshControls() {
    document.querySelectorAll('[data-setting]').forEach(el => {
      const key = el.dataset.setting, val = settings[key];
      if (el.classList.contains('seg')) {
        el.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.value === val));
      } else if (el.type === 'checkbox') el.checked = !!val;
      else el.value = val;
    });
    document.querySelectorAll('output[data-out]').forEach(o => {
      const k = o.dataset.out;
      o.textContent = FORMATS[k] ? FORMATS[k](settings[k]) : settings[k];
    });
    refreshFacts();
  }

  function refreshFacts() {
    $('fact-seed').textContent = String(gameStarted ? currentSeedLabel : (settings.seed || 'losowy'));
    $('fact-mountains').textContent = FORMATS.mountainScale(settings.mountainScale) + ' (szczyty do ~' + Math.round(560 * settings.mountainScale) + ' m)';
    $('fact-cities').textContent = FORMATS.cityDensity(settings.cityDensity);
    $('fact-time').textContent = fmtHour(settings.timeOfDay) + (settings.dayCycle ? ' (płynie)' : '');
  }

  function applyLive(key) {
    if (key === 'viewDist') { applyViewDistance(); invalidateChunks(); }
    else if (key === 'renderScale') applyRenderScale();
    else if (key === 'fov') { camera.fov = settings.fov; camera.updateProjectionMatrix(); }
    else if (key === 'timeOfDay') { gameHour = settings.timeOfDay; applyTimeOfDay(gameHour); }
    hudEl.classList.toggle('off', !settings.showHud);
  }

  document.querySelectorAll('[data-setting]').forEach(el => {
    const key = el.dataset.setting;
    if (el.classList.contains('seg')) {
      el.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        settings[key] = b.dataset.value; saveSettings(); refreshControls(); applyLive(key);
      });
    } else {
      el.addEventListener('input', () => {
        if (el.type === 'checkbox') settings[key] = el.checked;
        else if (el.type === 'range') settings[key] = parseFloat(el.value);
        else settings[key] = el.value;
        saveSettings(); refreshControls(); applyLive(key);
      });
    }
  });

  // ---- zakładki ----
  document.querySelectorAll('.nav-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + btn.dataset.tab));
  }));

  // ---- przyciski ----
  const randomSeedLabel = () => Math.floor(Math.random() * 1e9).toString();
  $('btn-dice').addEventListener('click', () => { settings.seed = randomSeedLabel(); saveSettings(); refreshControls(); });
  $('btn-random').addEventListener('click', () => { settings.seed = ''; saveSettings(); generateWorld(); requestPlay(); });
  $('btn-generate').addEventListener('click', () => { generateWorld(); requestPlay(); });
  $('btn-play').addEventListener('click', () => requestPlay());
  $('btn-reset-settings').addEventListener('click', () => {
    const keep = { seed: settings.seed };
    Object.assign(settings, DEFAULTS, keep);
    saveSettings(); refreshControls();
    ['viewDist', 'renderScale', 'fov', 'timeOfDay'].forEach(applyLive);
    toast('Przywrócono ustawienia domyślne');
  });

  function requestPlay() {
    if (!gameStarted) { generateWorld(); }
    try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* brak pointer lock */ }
  }

  function setMenuOpen(open) {
    menuEl.classList.toggle('hidden', !open);
    if (open) {
      $('menu-state').textContent = gameStarted ? 'Pauza' : 'Witaj';
      $('btn-play').textContent = gameStarted ? 'Wznów' : 'Graj';
      settings.timeOfDay = gameHour; refreshControls();
    }
    hudEl.classList.toggle('off', open || !settings.showHud);
    $('crosshair').classList.toggle('hidden', open || car.driving);
    if (open) dashEl.classList.add('hidden');
  }

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    setMenuOpen(!locked);
    if (!locked) for (const k in keys) keys[k] = false;
  });
  canvas.addEventListener('click', () => { if (!locked && gameStarted) requestPlay(); });

  // ---- klawiatura ----
  document.addEventListener('keydown', e => {
    if (!locked) return;
    if (e.repeat) { if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault(); return; }
    keys[e.code] = true;
    if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
    switch (e.code) {
      case 'KeyF': if (!car.driving) setFlying(!player.flying); break;
      case 'KeyR': settings.seed = ''; saveSettings(); generateWorld(); toast('Nowy świat: ' + currentSeedLabel); break;
      case 'KeyT': if (!car.driving) teleportToCity(); break;
      case 'KeyE': toggleCar(); break;
      case 'KeyG': if (!car.driving) callCar(); break;
      case 'KeyV': if (car.driving) car.view = car.view === 'chase' ? 'cockpit' : 'chase'; break;
      case 'KeyZ': manualShift(-1); break;
      case 'KeyX': manualShift(1); break;
      case 'KeyU': if (car.driving || Math.hypot(player.pos.x - car.p[0], player.pos.z - car.p[2]) < 12) flipCarUpright(); break;
      case 'Space':
        if (!car.driving) {
          const now = performance.now();
          if (now - lastSpaceTap < 300) setFlying(!player.flying);
          lastSpaceTap = now;
        }
        break;
    }
  });
  document.addEventListener('keyup', e => { keys[e.code] = false; });

  document.addEventListener('mousemove', e => {
    if (!locked) return;
    const s = BASE_SENS * settings.sens, iy = settings.invertY ? -1 : 1;
    if (car.driving) {
      car.look.yaw = clamp(car.look.yaw - e.movementX * s, -Math.PI, Math.PI);
      car.look.pitch = clamp(car.look.pitch - e.movementY * s * iy, -0.6, 0.9);
      car.look.idle = 0;
      return;
    }
    player.yaw -= e.movementX * s;
    player.pitch = clamp(player.pitch - e.movementY * s * iy, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---- deska rozdzielcza ----
  const dSpeed = $('dash-speed'), dUnit = $('dash-unit'), dGear = $('dash-gear'), dRpm = $('dash-rpm'), dNitro = $('dash-nitro');
  const lAbs = $('lamp-abs'), lTc = $('lamp-tc'), lHand = $('lamp-hand');
  function updateDash() {
    const on = car.driving && locked;
    dashEl.classList.toggle('hidden', !on);
    $('crosshair').classList.toggle('hidden', car.driving || !locked);
    if (!on) return;
    const mph = settings.units === 'mph';
    dSpeed.textContent = Math.round(Math.abs(car.speed) * (mph ? 2.23694 : 3.6));
    dUnit.textContent = mph ? 'mph' : 'km/h';
    dGear.textContent = car.gear < 0 ? 'R' : (Math.abs(car.speed) < 0.3 && car.thr < 0.05 && car.gear === 1 ? 'N' : car.gear) + (settings.autoGear ? '' : 'M');
    const rp = clamp((car.rpm - 500) / (CAR.REDLINE + 300 - 500), 0, 1);
    dRpm.style.width = (rp * 100).toFixed(0) + '%';
    dRpm.classList.toggle('red', car.rpm > CAR.REDLINE - 500);
    dNitro.style.width = (car.nitro * 100).toFixed(0) + '%';
    lAbs.classList.toggle('on', !!car.absActive);
    lTc.classList.toggle('on', !!car.tcActive);
    lHand.classList.toggle('on', car.hand > 0.5);
  }

  // ======================= START I PĘTLA GŁÓWNA =======================
  let currentSeedLabel = '';

  function resetWorld(newSeed) {
    seed = newSeed;
    world.seed = newSeed;
    perlin = new Perlin(seed);
    world.mScale = settings.mountainScale;
    world.cityChance = settings.cityDensity;
    clearWorldCaches();
    car.driving = false;
    player.vel.set(0, 0, 0);
    player.yaw = 0; player.pitch = -0.15;
    player.flying = false;
    const sp = findSpawn();
    player.pos.set(sp.x, sp.y + EYE_HEIGHT + 1, sp.z);
    updateChunks(60);
    player.pos.set(sp.x, surfaceAt(sp.x, sp.z, 1e9) + EYE_HEIGHT + 0.5, sp.z);
    callCar();
  }

  // punkt startu: najbliższe łagodne, suche miejsce (nie na stoku ani w wodzie)
  function findSpawn() {
    let best = { x: 0, z: 0, y: getHeight(0, 0), sc: Infinity };
    for (let r = 0; r <= 400; r += 16) {
      const n = r === 0 ? 1 : Math.max(8, Math.round(r / 8));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2, x = Math.cos(a) * r, z = Math.sin(a) * r;
        const h = baseHeight(x, z);
        if (h < WATER_LEVEL + 3 || h > 90) continue;
        let slope = 0;
        for (const [dx, dz] of [[8, 0], [-8, 0], [0, 8], [0, -8]]) slope = Math.max(slope, Math.abs(baseHeight(x + dx, z + dz) - h) / 8);
        const sc = slope * 400 + r * 0.05;
        if (sc < best.sc) best = { x, z, y: h, sc };
        if (slope < 0.06) return { x, z, y: h };
      }
    }
    return best;
  }

  function generateWorld() {
    const txt = String(settings.seed || '').trim();
    currentSeedLabel = txt || randomSeedLabel();
    resetWorld(seedFromString(currentSeedLabel));
    gameStarted = true;
    refreshControls();
  }

  let last = performance.now();
  let fpsAcc = 0, fpsFrames = 0, hudSlowT = 0, hudCarT = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!gameStarted) { renderer.render(scene, camera); return; }

    if (locked) {
      if (!car.driving) updatePlayer(dt);
      updateCar(dt);
      if (settings.dayCycle) { gameHour = (gameHour + dt / 60) % 24; applyTimeOfDay(gameHour); }
    }
    if (car.driving) player.pos.set(car.p[0], car.p[1] + 1.2, car.p[2]);
    if (carHeadLight) carHeadLight.visible = nightFactor > 0.35 || car.inTunnel;
    updateChunks(FRAME_BUDGET_MS);

    if (car.driving) updateCarCamera(dt);
    else {
      camera.position.copy(player.pos);
      camera.rotation.set(player.pitch, player.yaw, 0);
      if (camera.fov !== settings.fov) { camera.fov = settings.fov; camera.updateProjectionMatrix(); }
    }
    water.position.x = player.pos.x;
    water.position.z = player.pos.z;
    renderer.render(scene, camera);

    updateDash();
    hudCarT += dt;
    if (hudCarT >= 0.1) {
      hudCarT = 0;
      if (car.hintT > 0) hudCar.textContent = car.hint;
      else if (car.driving) {
        hudCar.textContent = (car.flipT > 1 ? 'Auto na dachu – U: postaw na koła' : '') + (car.inWater ? 'Woda!' : '') + (car.inTunnel ? 'Tunel' : '');
      } else {
        const dc = Math.hypot(player.pos.x - car.p[0], player.pos.z - car.p[2]);
        hudCar.textContent = dc <= CAR.ENTER_DIST ? 'Samochód: E – wsiądź' : 'Samochód: ' + Math.round(dc) + ' m (G – przywołaj)';
      }
    }
    fpsAcc += dt; fpsFrames++;
    if (fpsAcc >= 0.5) {
      const fps = Math.round(fpsFrames / fpsAcc);
      fpsAcc = 0; fpsFrames = 0;
      hudMode.textContent = car.driving ? 'Tryb: jazda 🚗 (' + (car.view === 'chase' ? 'zza auta' : 'z kabiny') + ')' : 'Tryb: ' + (player.flying ? 'latanie ✈' : 'chodzenie 🚶');
      hudPos.textContent = `X: ${player.pos.x.toFixed(0)}  Y: ${player.pos.y.toFixed(0)}  Z: ${player.pos.z.toFixed(0)}`;
      hudInfo.textContent = `FPS: ${fps} | Seed: ${currentSeedLabel} | Chunki: ${chunks.size} | ${fmtHour(gameHour)}`;
      const nc = nearestCity(player.pos.x, player.pos.z);
      hudCity.textContent = nc ? `Najbliższe miasto: ${CITY_STYLES[nc.city.style].name}, ${Math.round(nc.dist)} m (T – teleport)` : 'Najbliższe miasto: brak w pobliżu';
    }
  }

  // start: menu otwarte, w tle pusta scena; świat powstaje po „Graj”
  applyTimeOfDay(gameHour);
  applyRenderScale();
  refreshControls();
  setMenuOpen(true);
  camera.position.set(0, 30, 0);
  requestAnimationFrame(frame);

})();
