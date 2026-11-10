# NEXAR focused tests

Local only. These tests never connect to staging or production.

- `db.test.mjs` applies `fixture.sql` (a reduced copy of the staging objects), then the three
  `20261110…` migrations, to a throwaway **local** Postgres. It refuses any non-local host.
- `ui.test.mjs` and `send.test.mjs` load the real functions out of `index.html` (through `harness.mjs`) and run
  them against a fake page and backend.

```
cd tests/nexar && npm install
NEXAR_TEST_PG=postgres://postgres@127.0.0.1:5432/postgres npm test
```

Not covered here: the Edge Functions running on Deno, and behaviour in a real browser.
