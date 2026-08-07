/* Icon Forge — the artwork editor overlay.

   A full-screen frame around miniPaint (MIT, by Vilius L.), vendored under
   assets/iconforge/minipaint/ and loaded same-origin so we can drive it
   directly: artwork goes in through Layers.insert(), and the flattened result
   comes back out through Layers.convert_layers_to_canvas().

   The bundle is a black box — a prebuilt webpack build with a custom lasso
   tool. Do not hand-patch js/bundle.js; it is minified. All we do here is
   recolour its chrome to the wiki palette and shuttle one image each way. */

const MINIPAINT_URL = '/assets/iconforge/minipaint/index.html';

/* miniPaint's whole skin is driven by CSS custom properties on :root, so
   recolouring it is a variable remap. Injected into the (same-origin) iframe
   document after its bundle loads, so these rules win the cascade. */
const THEME_CSS = `
:root {
  /* workspace + text */
  --background: #241028;
  --text-color: #f0e8d5;
  --text-color-muted: #b9a88a;
  --text-color-red: #e8a79b;
  --text-color-green: #d6c496;
  --text-color-blue: #8fb0e8;
  --link-color: #d6c496;

  /* structural surfaces — deep purples */
  --section-background-color: #2c1333;
  --area-background-color: #3a1d42;
  --block-background-color: #3a1d42;
  --header-background-color: #241028;

  /* buttons */
  --button-background-color: #2c1333;
  --button-background-color-hover: #8a3526;
  --button-background-color-active: #5b1f21;
  --button-text-color-active: #ffe9ad;
  --button-toggle-background-color: #4a2548;
  --button-toggle-background-color-hover: #4a2548;

  /* inputs */
  --input-background-color: #241028;
  --input-background-color-hover: #3a1d42;
  --input-text-color: #f0e8d5;
  --input-border-color: #4a2548;
  --input-border-color-active: #d6c496;
  --input-group-border-color: #3a1d42;

  /* top menu bar */
  --menu-background-color: #1a0820;
  --menu-text-color: #f0e8d5;

  /* dropdown menus — parchment cards */
  --menu-dropdown-background-color: #f0e8d5;
  --menu-dropdown-border-color: #b79c6f;
  --menu-dropdown-text-color: #33241a;
  --menu-dropdown-text-muted-color: #8a7457;
  --menu-dropdown-hover-background-color: #e5d7b8;
  --menu-dropdown-hover-text-color: #5b1f21;
  --menu-dropdown-divider-color: #d7c9ab;

  /* selection states — maroon + gold instead of green */
  --background-color-active: #5b1f21;
  --background-color-hover: #4a2548;
  --text-color-active: #ffe9ad;
  --border-color: #4a2548;

  /* scrollbars */
  --scrollbar-track-color: #241028;
  --scrollbar-thumb-color: #4a2548;
}

/* The selected tool in the left toolbar reads better with a gold ring. */
.sidebar_left .item.active,
#tools_container .active { box-shadow: 0 0 0 2px #d6c496 inset; }
`;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/**
 * Open the editor.
 *
 * @param {object}  o
 * @param {HTMLImageElement|null} o.image  artwork to open with; null = blank canvas
 * @param {string}  o.title
 * @param {string}  o.hint
 * @param {string|null} o.thumb  data URL for the little "before" preview
 * @param {(img: HTMLImageElement) => void} o.onApply
 */
export function openEditor(o) {
  const overlay = el('div', 'if-editor');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', o.title);

  const bar = el('div', 'if-editor-bar');
  const left = el('div', 'if-loaded');
  left.style.cssText = 'margin:0;padding:0;background:none;border:0';
  if (o.thumb) {
    const t = document.createElement('img');
    t.src = o.thumb;
    t.alt = 'Your artwork before editing';
    left.appendChild(t);
  }
  const heads = el('div');
  const h = el('h2', null, o.title);
  const p = el('p', null, o.hint);
  heads.appendChild(h);
  heads.appendChild(p);
  left.appendChild(heads);

  const btns = el('div', 'if-btn-row');
  const cancel = el('button', 'sb-btn if-btn-quiet', 'Cancel');
  cancel.type = 'button';
  const apply = el('button', 'sb-btn if-btn-go', 'Use this artwork');
  apply.type = 'button';
  apply.disabled = true;
  btns.appendChild(cancel);
  btns.appendChild(apply);

  bar.appendChild(left);
  bar.appendChild(btns);

  const frameWrap = el('div', 'if-editor-frame');
  const loading = el('div', 'if-editor-load');
  loading.appendChild(el('div', 'if-spin'));
  const loadMsg = el('p', null, 'Summoning the editor… the first load is a one-time 1.4 MB download, which a phone on a slow connection can take a while over.');
  loading.appendChild(loadMsg);
  const frame = document.createElement('iframe');
  frame.title = o.title;
  frame.src = MINIPAINT_URL;
  frameWrap.appendChild(frame);
  frameWrap.appendChild(loading);

  overlay.appendChild(bar);
  overlay.appendChild(frameWrap);
  document.body.appendChild(overlay);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.body.style.overflow = prevOverflow;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) {
    // Esc belongs to the editor's own tools while it has focus; only close
    // from the frame around it.
    if (e.key === 'Escape' && e.target !== frame && !frameWrap.contains(e.target)) close();
  }
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);

  frame.addEventListener('load', async () => {
    const w = frame.contentWindow;
    if (!w) return;
    // miniPaint registers window.Layers once its bundle finishes. Slow mobile
    // connections can need minutes — keep waiting, and only give up on a real
    // error reported by the page itself.
    for (let i = 0; i < 480 && !w.Layers; i++) {
      if (w.__mpError) {
        loading.innerHTML = '';
        loading.appendChild(el('p', 'err', 'The editor failed to load.'));
        loading.appendChild(el('p', null, String(w.__mpError)));
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const Layers = w.Layers;
    if (!Layers) {
      loading.innerHTML = '';
      loading.appendChild(el('p', 'err', 'The editor never started.'));
      loading.appendChild(el('p', null, 'It timed out after two minutes. Close this and try again, or edit your artwork elsewhere and upload the result.'));
      return;
    }

    try {
      const doc = frame.contentDocument;
      if (doc && !doc.getElementById('iconforge-theme')) {
        const style = doc.createElement('style');
        style.id = 'iconforge-theme';
        style.textContent = THEME_CSS;
        doc.head.appendChild(style);
      }
    } catch {
      // Theming is cosmetic — never block the editor over it.
    }

    if (o.image) {
      try {
        const doc = frame.contentDocument;
        if (!doc) throw new Error('editor document unavailable');
        // The source's own .src may be a revoked blob URL, so re-encode it
        // through a canvas. The <img> is created inside the iframe's document
        // so miniPaint owns it.
        const width = o.image.naturalWidth || o.image.width;
        const height = o.image.naturalHeight || o.image.height;
        const copy = document.createElement('canvas');
        copy.width = width;
        copy.height = height;
        copy.getContext('2d').drawImage(o.image, 0, 0);
        const img = doc.createElement('img');
        img.src = copy.toDataURL('image/png');
        await img.decode();
        await Layers.insert({
          name: 'artwork',
          type: 'image',
          data: img,
          width,
          height,
          width_original: width,
          height_original: height
        });
      } catch {
        // Insert failed — the editor still opens on a blank canvas.
      }
    }

    loading.hidden = true;
    apply.disabled = false;
  });

  apply.addEventListener('click', async () => {
    const w = frame.contentWindow;
    const Layers = w && w.Layers;
    if (!Layers) return;
    apply.disabled = true;
    apply.textContent = 'Bringing it back…';
    try {
      const dim = Layers.get_dimensions();
      const canvas = document.createElement('canvas');
      canvas.width = dim.width;
      canvas.height = dim.height;
      Layers.convert_layers_to_canvas(canvas.getContext('2d'));
      const img = new Image();
      img.src = canvas.toDataURL('image/png');
      await img.decode();
      close();
      o.onApply(img);
    } catch (e) {
      apply.disabled = false;
      apply.textContent = 'Use this artwork';
      loadMsg.textContent = 'Could not read the canvas back: ' + (e && e.message ? e.message : e);
      loading.hidden = false;
    }
  });
}
