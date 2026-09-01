# Vendored third-party libraries (Fancy Scripts)

Unmodified UMD builds, committed because the wiki has no bundler and loads
no external CDNs. Both are lazy-loaded by `assets/fancyscripts/app.js` the
first time an export is asked for — nothing here loads on an ordinary visit.

| File | Package | Version | Global | Used for |
|---|---|---|---|---|
| `html-to-image.min.js` | [html-to-image](https://www.npmjs.com/package/html-to-image) | 1.11.13 | `htmlToImage` | Capturing the rendered sheet DOM to a print-resolution PNG |
| `jspdf.umd.min.js` | [jspdf](https://www.npmjs.com/package/jspdf) | 4.2.1 | `jspdf` | Wrapping that PNG (plus the damask back cover) into a PDF |

Upgrading: replace the file with the new version's UMD build and update this
table. Neither file carries local patches.
