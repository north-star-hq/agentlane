# Mobile: Home, the sheet and Details

Home has a ticker (`Open for N s`), a counter, a name input with a greeting, a notifications switch, buttons to the sheet, Details and the API screen, and 40 rows, most of them below the fold. The sheet is a native form sheet at 40% height; Details is a second screen on the stack.

## How a user reaches it

Home is the first screen after launch. The sheet opens from `home-open-sheet` and closes with `sheet-close` or by dragging it down. Details opens from `home-open-details` and closes with `details-back` or the header's back button.

## Drive and prove

| Action                                          | Result to look for                           |
| ----------------------------------------------- | -------------------------------------------- |
| Tap `home-increment` twice                      | `home-tap-count` reads `Taps: 2`             |
| Type a name into `home-name-input`, press Enter | `home-greeting` reads `Hello, <name>`        |
| Toggle `home-notify-switch`                     | `home-notify-state` flips between off and on |
| Scroll to `row-40` and tap it                   | `Row 40 (selected)`                          |
| Open the sheet, then close it                   | `sheet-screen` appears, then Home again      |
| Open Details, then go back                      | `details-screen`, then Home again            |

The replayable proofs are `.maestro/home.yaml`, `.maestro/sheet.yaml` and `.maestro/navigation.yaml`.

## Traps

- The ticker changes every second, so a screen comparison that includes it always differs.
- `row-40` is off screen at launch; scroll before tapping it.
