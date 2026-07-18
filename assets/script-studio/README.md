# Script Studio — Asset Pack

Extracted from `nogreaterjoy.psd` (1500×2100 px, the "No Greater Joy" script sheet design).
This pack is the raw material for the Script Studio feature — see `PLAN.md` in this folder.

## Layout manifest

**`template.json`** is the machine-readable description of the whole design: canvas size,
palette, font specs, every chrome layer with its exact PSD coordinates, the night-order
column geometry, team section definitions, and the complete demo sheet (all 11 characters
with icon/name/ability positions). It is the seed of the Script Studio document model —
the default template the renderer will lay out from, and what the editor mutates.

## template/ — reusable sheet chrome

The script-agnostic skeleton, positioned per `template.json`:

- `bg-parchment.jpg` — full-canvas parchment background (opaque, JPEG for weight)
- `bar-left.png` / `bar-right.png` — purple textured side bars (night-order columns live on these)
- `botanical-top-left/top-right/bottom-left/bottom-right.png` — watercolor corner foliage
- `botanical-berries-left.png` — extra berry sprig layered over the bottom-left corner
- `clock.png` — inked clockwork emblem (title-block decoration)
- `divider-townsfolk/outsiders/minions/demon.png` — the four horizontal section rules
- `night-moon-left/right.png` — dusk markers (top of each night column)
- `night-sun-left/right.png` — dawn markers (bottom of each column; hidden in the PSD but part of the design)

### template/alt/ — alternates

All 29 hidden layers from the PSD: earlier icon passes, alternate botanicals, frame
experiments. Kept verbatim (`alt-NN-layername.png`) so nothing from the design file is lost;
some may become theme variants later.

## demo/ — "No Greater Joy" showcase content

Script-specific art proving the style; also the default demo sheet the tool opens with:

- `icon-*.png` — 11 watercolor character icons (blue good / red evil style)
- `night-mini-*.png` — the small night-order column icons
- `title-nogreaterjoy.jpg` — the styled title, rasterized from the reference export
  (the source font is commercial — see licensing)
- `reference.jpg` — the target render, straight from the design file's author

## Fonts (pushed to `assets/fonts/`)

| Role | PSD font | Shipped | Substitute |
|---|---|---|---|
| Title | LHF Unlovable | ❌ commercial | **Dumbledor** (`dum2.ttf`, already self-hosted) + canvas gradient/bevel |
| Names & headers | OptimusPrinceps | ✅ `OptimusPrinceps.ttf` + SemiBold | — |
| Ability text | Helvetica | ❌ commercial | **Trade Gothic LT Std** (already self-hosted) |

OptimusPrinceps is Manfred Klein freeware (free for private/charity use — fine for the wiki).
LHF Unlovable must not be redistributed; the demo title ships only as a rasterized image.

## Team palette (sampled from the PSD type layers)

- Townsfolk `#0064AC` · Outsider `#0A3E64` · Minion `#640A0A` · Demon `#D00000`
- Night column labels: white on purple bar · Body ink: black
