# PaperPot

A static web app for designing slab-built pottery and printing true-to-scale paper templates.

## Run locally

```bash
python3 -m http.server 8000
```

Open http://localhost:8000. It must be served over HTTP (not opened as a file) because it uses ES modules.

## Structure

Plain HTML, CSS and JavaScript modules with no build step. three.js is loaded from a CDN for the 3D view.

| File | Purpose |
|---|---|
| `index.html`, `style.css` | page and styles |
| `app.js` | interface |
| `model.js` | parts, joins, stacking, template pieces |
| `templates.js` | flat geometry, page tiling, printable SVG pages |
| `view3d.js` | 3D preview |

## Deploy

`.github/workflows/pages.yml` publishes the repository to GitHub Pages on every push to `main`.
