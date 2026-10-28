import assert from "node:assert/strict"
import { test } from "node:test"
import { parseDuration } from "../src/duration.js"

test("hours and minutes", () => assert.equal(parseDuration("1h30m"), 5400))
test("seconds", () => assert.equal(parseDuration("45s"), 45))
test("rejects garbage", () => assert.throws(() => parseDuration("soon"), SyntaxError))
test("rejects trailing junk", () => assert.throws(() => parseDuration("10m and change"), SyntaxError))
test("rejects unknown units", () => assert.throws(() => parseDuration("3d"), SyntaxError))
