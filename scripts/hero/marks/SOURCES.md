# Marks in the hero

The hero draws these files into the agent chips and the device labels. The companies' files are byte-for-byte as downloaded (SHA-256 below); the generator only reads their path data and fills. All were fetched on 2026-10-13.

## Codex: the OpenAI Blossom

- Files: `openai-blossom-black.svg` (light theme), `openai-blossom-white.svg` (dark theme).
- Source: `OpenAI-logos/SVGs/OAI_OpenAI-Blossom_Black.svg` and `..._White.svg` in https://cdn.openai.com/brand/openai-logos.zip, the "Download logos" button on https://openai.com/brand/. The Codex product page (https://openai.com/codex/) serves the same Blossom as its icon.
- Terms: OpenAI's design guidelines and usage terms on https://openai.com/brand/ (the "How to use our Logos" list and "Usage terms"). Using the logo means agreeing to those terms; the permission is non-exclusive, revocable, and OpenAI may require changes. The hero follows them: the Blossom only names Codex, an OpenAI service; it is used exactly as supplied, in black or white with no colour added; it is smaller than the agentlane lockup; it is not part of our branding; it sits on a plain chip with space around it.
- SHA-256: black `75c1e9fffa5e8c437bec1d67197a73992bca45d166c6ff23215185dea8fae92a`, white `01d158767c4eec0e47bd617e67759c33da0accd1438be1a8d29dfdb99ce87285`.

## Cursor: the 2D cube

- Files: `cursor-cube-2d-light.svg` (light theme), `cursor-cube-2d-dark.svg` (dark theme).
- Source: `General Logos/Cube/SVG/CUBE_2D_LIGHT.svg` and `CUBE_2D_DARK.svg` in https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip, the "Download brand assets" link on https://cursor.com/brand.
- Terms: the brand page offers the cube on its own, in 2D by default, light and dark, and asks to be called "Cursor". It sets no other rules, and Cursor's terms of service say nothing about the logo. The hero uses the 2D cube as supplied, unaltered.
- SHA-256: light `c483c02f78eb2619778fdd959e72a9adfac4844854472cd2653d4cbfd60e4d71`, dark `cd0e3e5d8991a4cdd4577f8896cd063105207665165c73e25a1ff918dd367eb7`.

## Android: the robot head

- File: `android-head-flat.svg`.
- Source: https://developer.android.com/static/images/brand/android-head_flat.svg, from "Android robot" on https://developer.android.com/distribute/marketing-tools/brand-guidelines.
- Terms: Creative Commons Attribution 3.0. The guidelines require this line with the creative: "The Android robot is reproduced or modified from work created and shared by Google and used according to terms described in the Creative Commons 3.0 Attribution License." The generator writes it into both hero SVGs, and the README must carry it with the hero. Google keeps the trademark rights to the robot. The hero uses it unaltered, in its own colours.
- SHA-256: `5f05dae657da9f31e5d4a09b7976f39881617f6b3e4d4562d9ee16295d250bdb`.

## Neutral glyphs drawn for the hero

- `terminal.svg` stands for Claude Code. Anthropic's trademark guidelines (https://www.anthropic.com/legal/trademark-guidelines, effective 2024-08-01) allow its marks only in materials Anthropic approves beforehand, so the Claude spark from Anthropic's press kit (https://www.anthropic.com/press-kit, `Claude logos/3 Claude Spark/SVG/Claude Spark - Clay.svg`) is not used. With Anthropic's written approval (marketing@anthropic.com), add the spark here and point the `claude` entry in `marks.ts` at it.
- `globe.svg` stands for the browser, with no browser vendor's logo.
- `phone.svg` stands for iOS: a phone outline with a Dynamic Island. Apple's trademark guidelines don't allow the Apple logo in third-party materials.
- These three were drawn for this project.
