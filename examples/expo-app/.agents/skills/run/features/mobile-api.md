# Mobile: the API screen

Home's API button opens a screen that reads `GET /items` from the API the app was launched with and lists the places, with the port that served them and a Reload button. It has two other states: an error when the API can't be reached, and "No API configured" when the app was launched without `-apiBaseUrl`.

## How a user reaches it

Home, then the API button (`home-open-api`). `up` launches the app with `-apiBaseUrl http://localhost:$AGENTLANE_API_PORT`, so the screen reads this lane's database.

## Drive and prove

| Action                                                 | Result to look for                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Tap `home-open-api`                                    | `api-result`, `api-served-by` reading `Served by port $AGENTLANE_API_PORT`, `api-item-harbor` … `api-item-gallery` |
| Add a place through the web app, then tap `api-reload` | the new place in the list: both apps read the same lane's database                                                 |
| Launch with the API stopped                            | `api-error` and "Could not reach the API"                                                                          |
| Launch without `-apiBaseUrl`                           | `api-unconfigured`                                                                                                 |

The replayable proof is `.maestro/api.yaml`; the two other states are `.maestro/states/api-down.yaml` and `.maestro/states/no-api.yaml` (see the README for their launch conditions).

## Traps

- A place added on this lane shows in the list too; `api.yaml` checks the seeded places by testID and doesn't count rows.
- The flows take `METRO_PORT` and `API_PORT` as parameters; run them through `agentlane exec -- sh -c '...'` so the lane's values reach them.
