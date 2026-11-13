import assert from 'node:assert/strict'
import { test } from 'node:test'

// Deliberately red, on a throwaway branch: it exists to prove that a pull request with a failing leg
// cannot merge into a protected main even for an administrator. Never merged.
test('probe: this test fails on purpose', () => {
  assert.fail('deliberate failure, to hold the pull request open')
})
