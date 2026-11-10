// Height-coded top-down ASCII view of generated arenas.
//   node tools/mapcheck-ascii.mjs [--gen path/to/mapgen.js] [--players 4] [--arch id] seed [seed…]
// Legend: ' ' walkable floor   '.' floor the nav grid avoids   s stairs/plinth (< 1.2 m)
//         1 2 3 4 = tiers 1.2 / 2.4 / 3.6 / 4.8 m   # = rim wall   = catwalk (open below)
//         _ lintel (slide under)   ^ jump pad   S spawn   + health   O overprint
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function ascii(map, navIndexFn) {
  const half = map.size / 2, n = map.size;
  const rows = [];
  for (let cz = n - 1; cz >= 0; cz--) {
    let row = '';
    for (let cx = 0; cx < n; cx++) {
      const x = -half + cx + 0.5, z = -half + cz + 0.5;
      const col = map.boxes.filter((b) => b.kind !== 'floor' && x > b.min[0] && x < b.max[0] && z > b.min[2] && z < b.max[2]).sort((a, b) => a.min[1] - b.min[1]);
      let top = 0, gap = 0, ch = null;                       // gap = clearance under the topmost box
      for (const b of col) { if (b.min[1] > top + 0.01) gap = b.min[1] - top; else if (b.max[1] > top) gap = gap && b.min[1] > 0.01 ? gap : 0; top = Math.max(top, b.max[1]); }
      if (col.length) ch = gap > 2 ? '=' : gap > 1 ? '_' : top < 1.1 ? 's' : top > 5 ? '#' : String(Math.round(top / 1.2));
      if (!ch) ch = map.nav.walk[cz * map.nav.w + cx] ? ' ' : '.';
      if (map.jumpPads.some((p) => x > p.min[0] && x < p.max[0] && z > p.min[2] && z < p.max[2])) ch = '^';
      row += ch;
    }
    rows.push(row.split(''));
  }
  const put = (p, ch) => {
    const cx = Math.floor(p[0] + half), cz = Math.floor(p[2] + half);
    if (rows[n - 1 - cz]) rows[n - 1 - cz][cx] = ch;
  };
  for (const s of map.spawns) put(s.pos, 'S');
  for (const p of map.pickups) put(p.pos, p.type === 'health' ? '+' : 'O');
  return rows.map((r) => '#' + r.join('') + '#').join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args.splice(i, 2)[1] : def; };
  const gen = path.resolve(opt('gen', new URL('../shared/mapgen.js', import.meta.url).pathname));
  const players = Number(opt('players', 4));
  const arch = opt('arch', null);
  const { generateMap } = await import(pathToFileURL(gen).href);
  for (let seed of args.map(Number)) {
    let map = generateMap(seed, players);
    while (arch && map.archetype !== arch) map = generateMap(++seed, players);
    const walk = map.nav.walk.reduce((a, b) => a + b, 0) / map.nav.walk.length;
    console.log(`\nseed ${seed} · ${players}p · ${map.name} · ${map.archetype} · ${map.size} m · ${map.boxes.length} boxes · ${map.spawns.length} spawns · nav ${(walk * 100).toFixed(0)}%`);
    console.log(ascii(map));
  }
}
