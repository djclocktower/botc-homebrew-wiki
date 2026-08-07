/* Icon Forge — texture registry.

   The sheets are reverse-engineered from the official BOTC icons by matteipis
   (github.com/matteipis/Reverse-engineered-BotC-textures). Every icon on the
   real cards is a crop of one of these, which is why the engine renders them
   as one continuous field rather than tiling per region.

   `label`/`sub` are what the Character type picker shows, so they use the
   wiki's team words. The Traveller II entry has no sheet of its own — it
   loads blue + red and lets the engine split them down a divider. */

const BASE = '/assets/iconforge/textures/';

export const COLOR_TEXTURES = [
  { id: 'blue', label: 'Good', sub: 'Townsfolk · Outsider', file: BASE + 'blue.png' },
  { id: 'red', label: 'Evil', sub: 'Minion · Demon', file: BASE + 'red.png' },
  { id: 'brown', label: 'Traveller', sub: 'Either alignment', file: BASE + 'brown.png' },
  {
    id: 'traveller_split',
    label: 'Traveller II',
    sub: 'Good / evil split',
    // Tile preview is special-cased in the picker; the engine loads blue+red.
    file: BASE + 'blue.png'
  },
  { id: 'yellow_fibbin', label: 'Fabled', sub: 'Gold variant', file: BASE + 'yellow_fibbin.png' },
  { id: 'green_pope', label: 'Loric', sub: 'Green variant', file: BASE + 'green_pope.png' },
  { id: 'white', label: 'Monochrome', sub: 'All white', file: BASE + 'white.png' }
];

/** Character type that renders as a blue/red split with a divider line. */
export const TRAVELLER_SPLIT_ID = 'traveller_split';

/** The parchment sheet used for every white detail region and the cream border. */
export const WHITE_TEXTURE = COLOR_TEXTURES.find((t) => t.id === 'white');

const cache = new Map();

export function loadTexture(def) {
  let p = cache.get(def.id);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load the ' + def.label + ' texture'));
      img.src = def.file;
    });
    cache.set(def.id, p);
  }
  return p;
}

/** Load the texture pair for a picked character type. Traveller II is the one
 *  entry that needs three sheets: blue on the left, red on the right, and the
 *  parchment for details. */
export function loadTexturesFor(id) {
  const white = loadTexture(WHITE_TEXTURE);
  if (id === TRAVELLER_SPLIT_ID) {
    const blue = COLOR_TEXTURES.find((t) => t.id === 'blue');
    const red = COLOR_TEXTURES.find((t) => t.id === 'red');
    return Promise.all([loadTexture(blue), loadTexture(red), white]).then(
      ([color, color2, w]) => ({ color, color2, white: w })
    );
  }
  const c = COLOR_TEXTURES.find((t) => t.id === id) || COLOR_TEXTURES[0];
  return Promise.all([loadTexture(c), white]).then(([color, w]) => ({ color, white: w }));
}
