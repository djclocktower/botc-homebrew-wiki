# BOTC HomeBrew Wiki

A fan-made wiki for Blood on the Clocktower homebrew characters.

## Structure

```
botc-wiki/
  index.html              ← Homepage (lists all characters)
  assets/
    styles.css            ← All shared CSS
    bg.jpg, logo_skull.png, parchment.jpg ...  ← Shared images
  characters/
    folie-a-deux.html     ← Example character page
    your-new-character.html
```

## Adding a new character

1. Copy `characters/folie-a-deux.html` and rename it (e.g. `characters/zealot.html`)
2. Edit the text content inside the new file
3. Replace the image `src` paths in the `<img>` tags with your own assets in `assets/`
4. Add a card for the new character in `index.html` (copy the existing `<a class="char-card">` block)

## Hosting on Netlify

1. Zip the entire `botc-wiki/` folder
2. Go to netlify.com → New site → Deploy manually
3. Drag the ZIP onto the deploy area
4. Done — your site is live!

To add a custom domain: Site settings → Domain management → Add custom domain.
