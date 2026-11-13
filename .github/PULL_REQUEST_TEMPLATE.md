## What changed

<!-- One or two sentences. If it needs "and", it is probably two PRs. -->

## How it was verified

<!-- Commands run and numbers observed. Not "tested locally". A dry run against a real store is a
     result worth pasting; a deletion is worth pasting with the ids and the bytes. -->

## Affected modules

<!-- plugin / engine / bundle / tools / docs / ci -->

## Effect on a real store

<!-- Does this change what could be deleted? Any change to the candidate rule, the protection rule or
     the link rule does. Say which, and which test now covers it. If nothing, write "none". -->

## Documents touched

<!-- Which of these did you have to change? Tick, or write "none". -->
- [ ] a tool name, parameter or result field → `docs/design.md`, README pair
- [ ] the candidate or protection rule → `docs/design.md` §4, and an ADR if the decision changed
- [ ] a bundle config key or patch row → README pair, `docs/design.md` §2
- [ ] the storage layout or the id escaping → `docs/design.md` §3 and a new ADR
- [ ] a document added, renamed or removed → the README pair's document list

## Checklist

- [ ] `node --check index.js` and `node --check engine.js` pass
- [ ] `node scripts/check.mjs` passes
- [ ] `npm test` passes
- [ ] A check or a test was seen to fail before it was trusted
- [ ] Every deletion claim has a test that deletes nothing it should not
- [ ] The README pair updated in this same PR
- [ ] No machine-specific path in any shared document
- [ ] If the engine was exercised against a real store: the ids, the bytes and whether it was a copy
      are in "How it was verified"
