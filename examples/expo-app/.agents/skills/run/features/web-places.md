# Web: sign in and places

The web app at `$AGENTLANE_WEB_URL`: a sign-in page, then a signed-in page listing the places with the API port that served them, a Shortest first toggle, a form to add a place, and Sign out.

## How a user reaches it

- Opening the URL signed out shows the sign-in page; signed in (the `session` cookie), it shows the places at once. The lane's browser starts signed in from the `signin` hook's saved login.
- Reloading keeps the session.

## Drive and prove

| Action                                                       | Result to look for                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Fill Email and Password with the test account, press Sign in | `signed-in-as` reads `Signed in as Test User (tester@example.com)`                      |
| The same with a wrong password                               | the alert `wrong email or password`, still on the sign-in page                          |
| Look at the list                                             | the three seeded places, and `served-by` reads `Served by port $AGENTLANE_API_PORT`     |
| Fill Place with a unique name and Minutes, press Add place   | the place in the list; after a reload it is still there, and `GET /items` returns it    |
| Press Shortest first, then press it again                    | the places ordered by minutes and the button pressed, then the order they were added in |
| Press Sign out                                               | the sign-in page; `POST /api/items` now answers 401                                     |

The replayable proof is `node_modules/.bin/agentlane exec -- npx playwright test`, which runs all of these: `web/tests/signed-in.spec.ts` from the saved login, and `web/tests/signed-out.spec.ts` for the sign-in form and sign-out.

## Traps

- The lane's database keeps every row added on this lane, test runs included. Use a unique name for a row you add, and look for that name rather than counting rows.
- A row added here is invisible to another lane; that is the database per lane working, not a bug.
- The web app reaches the API only through `/api/*` on its own origin. A `curl` to the API port directly needs `Authorization: Bearer <token>` from `POST /session`, since the cookie belongs to the web app's origin.
- Sign out in the lane's browser ends the saved login's session on the API, so the browser stays signed out until the next `agentlane up` runs the `signin` hook again. The tests sign out only a session they signed in themselves.
