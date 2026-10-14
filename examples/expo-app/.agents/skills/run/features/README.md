# Feature map

Every page starts from a lane brought up with `node_modules/.bin/agentlane up` (mobile) or `up --platform web` (web), doctor `ready`, and the lane's database as its first `up` seeded it: the test account `tester@example.com` / `example-password` and the places Harbor walk (25 min), Covered market (40 min) and Small gallery (55 min), plus whatever earlier runs on this lane added. The web app starts signed out; the mobile app has no sign-in.

| Page                             | Feature                                                | Apps   |
| -------------------------------- | ------------------------------------------------------ | ------ |
| [web-places.md](web-places.md)   | Sign in, see the places, add one, sign out             | web    |
| [mobile-api.md](mobile-api.md)   | The API screen: the places, the error and unset states | mobile |
| [mobile-home.md](mobile-home.md) | Home's controls, the sheet and Details                 | mobile |
