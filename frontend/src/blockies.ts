/**
 * Deterministic "blockies"-style identicon for an address, rendered as an SVG
 * data URI. Same address always yields the same icon, so each guzzler gets a
 * recognizable visual marker. Ported from the canonical Ethereum blockies
 * algorithm (Alexander Husøy), trimmed to emit SVG instead of a canvas.
 *
 * Results are memoized per address: the long guzzler list re-renders often
 * (15s refresh) and we never want to recompute an icon we have already built.
 */

export const ADDRESS_FACE_DATA_URI_PREFIX = "data:image/svg+xml,";

const cache = new Map<string, string>();
const SIZE = 8; // grid is 8x8 cells, mirrored horizontally
const randseed = new Int32Array(4);

function seedrand(seed: string): void {
  randseed.fill(0);
  for (let i = 0; i < seed.length; i++) {
    randseed[i % 4] = (randseed[i % 4]! << 5) - randseed[i % 4]! + seed.charCodeAt(i);
  }
}

function rand(): number {
  const t = randseed[0]! ^ (randseed[0]! << 11);
  randseed[0] = randseed[1]!;
  randseed[1] = randseed[2]!;
  randseed[2] = randseed[3]!;
  randseed[3] = randseed[3]! ^ (randseed[3]! >> 19) ^ t ^ (t >> 8);
  return (randseed[3]! >>> 0) / 4294967296;
}

function createColor(): string {
  const h = Math.floor(rand() * 360);
  const s = `${rand() * 60 + 40}%`;
  const l = `${(rand() + rand() + rand() + rand()) * 25}%`;
  return `hsl(${h},${s},${l})`;
}

function createImageData(): number[] {
  const dataWidth = Math.ceil(SIZE / 2);
  const mirrorWidth = SIZE - dataWidth;
  const data: number[] = [];
  for (let y = 0; y < SIZE; y++) {
    let row: number[] = [];
    for (let x = 0; x < dataWidth; x++) row[x] = Math.floor(rand() * 2.3);
    const mirror = row.slice(0, mirrorWidth).reverse();
    row = row.concat(mirror);
    for (const cell of row) data.push(cell);
  }
  return data;
}

/** Returns an `data:image/svg+xml` URI for the address's identicon. */
export function addressFaceDataUri(address: string): string {
  const key = address.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  seedrand(key);
  const color = createColor();
  const bgcolor = createColor();
  const spotcolor = createColor();
  const data = createImageData();

  let rects = "";
  data.forEach((value, i) => {
    if (value === 0) return; // background, painted by the base rect
    const fill = value === 1 ? color : spotcolor;
    const x = i % SIZE;
    const y = Math.floor(i / SIZE);
    rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`;
  });

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" ` +
    `shape-rendering="crispEdges" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" fill="${bgcolor}"/>${rects}</svg>`;

  const uri = `${ADDRESS_FACE_DATA_URI_PREFIX}${encodeURIComponent(svg)}`;
  cache.set(key, uri);
  return uri;
}

export const blockieDataUri = addressFaceDataUri;
