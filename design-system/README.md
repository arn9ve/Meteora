# Meteora design system

The look of the Meteora app, written down so the pitch, the README media and future videos match it. It is for this project only.

| File | What it is |
| --- | --- |
| [`meteora.css`](meteora.css) | Colour, type and space tokens as CSS variables, plus the components below. Link it and use the `m-` classes. |
| [`icons.svg`](icons.svg) | 26 line icons and the logo mark as an SVG sprite: `<svg class="m-icon"><use href="#i-drone"/></svg>`. |
| [`tokens.json`](tokens.json) | The same values as data, for video tools (HyperFrames) and anything that is not CSS. |

## The rules

- **One world.** White paper, ink grey text, a grid of small grey marks as the ground. Red is the only accent and means one of three things: an alarm, a red zone, or Grok speaking.
- **One family, one weight.** Arial (Helvetica as fallback), regular weight. Size makes the hierarchy, never bold. Big text gets tight letter-spacing (-0.035em), small captions get spaced capitals (0.12em).
- **Square.** No rounded corners. Circles are only state dots.
- **Lines, not shadows.** A 1 px `#e6e6e6` line marks an object. Touching boxes share one line.
- **State in dots.** Filled = on, hollow = off, red = alarm. Black and Red drones keep their own colour.
- **The dot grid moves with the voice.** At rest the marks are light grey; when something happens a band of marks turns dark; while Grok listens or speaks it turns red.

## Components

| Class | Use |
| --- | --- |
| `m-caption` | Small spaced capitals for labels and eyebrows (`is-red` for Grok and alarms). |
| `m-dot` | State dot: `is-on`, `is-alarm`, `is-black`, `is-red`. |
| `m-tab` | A dot and a word, for tabs and status in a top bar. |
| `m-btn` | Square button: default (line), `is-primary` (ink), `is-danger` (red, only Emergency land). |
| `m-chip` | Something that is on: a drone, a phone, a zone (`is-alarm` when a person is inside). |
| `m-card` | A lined box. |
| `m-switch` | Square switch on a checkbox. |
| `m-grok` | Who speaks (caption) and the words (large, light). `is-you` adds quotes. |
| `m-dots` | The dot grid as a background. |
| `m-icon` | 24 px line icon from the sprite. |

## For videos

1920 × 1080, 96 px safe margin, paper with the dot grid behind everything. Captions in `m-caption` style, titles in the display size. Use red only when the video shows an alarm or Grok talking. Real footage always sits in a lined frame with a small "Real" tag; simulated footage gets a dashed "Simulated" tag.
