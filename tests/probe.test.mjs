import assert from 'node:assert/strict'
import { test } from 'node:test'

// A deliberate failure, on a throwaway branch: it exists to prove that a red pull request cannot merge
// into a protected main. Never merged.
test('probe: this test fails on purpose', () => {
  assert.fail('deliberate failure to hold the pull request open')
})
