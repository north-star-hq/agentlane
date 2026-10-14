# agentlane brand

The mark is three lanes leaning forward on a dark tile. The middle one, lit in road-marking yellow, is the lane your agent holds.

| File               | Use                                                                         |
| ------------------ | --------------------------------------------------------------------------- |
| `mark.svg`         | The mark alone: favicon, avatar, plugin icon. Holds at 16 px.               |
| `mark-mono.svg`    | One-colour mark, for places that take a single colour.                      |
| `lockup-light.svg` | Mark and wordmark on a light background.                                    |
| `lockup-dark.svg`  | Mark and wordmark on a dark background. Its background is transparent.      |
| `tokens.css`       | Colour and type tokens for light and dark themes, as CSS custom properties. |

The wordmark is set in Overpass ExtraBold and converted to outlines, so the SVGs need no font installed. The name is always written lowercase: agentlane.

## Colour

| Token              | Light     | Dark      |
| ------------------ | --------- | --------- |
| `--al-bg`          | `#F4F4F2` | `#0E0F12` |
| `--al-surface`     | `#FFFFFF` | `#181A1F` |
| `--al-text`        | `#121316` | `#F3F3F1` |
| `--al-muted`       | `#585B62` | `#9EA1A8` |
| `--al-border`      | `#D9DAD6` | `#2B2E35` |
| `--al-accent`      | `#FFC629` | `#FFC629` |
| `--al-accent-text` | `#855A00` | `#FFC629` |
| `--al-on-accent`   | `#121316` | `#121316` |

The yellow is a fill. On a light background it sits behind dark text (`--al-on-accent`, 11.8:1) and never carries text itself; text in the accent colour uses `--al-accent-text` (5.5:1 on light, 12.2:1 on dark). Body text is 16.9:1 on light and 17.3:1 on dark.

## Type

Overpass for headings (weight 800) and body (400), Overpass Mono for code. Both are under the SIL Open Font License 1.1 and can be self-hosted.
