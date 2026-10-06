import assert from "node:assert/strict";
import { test } from "node:test";
import { clearSecretCache, interpolate, resolveSecret } from "./interpolate";

test("interpolate reads $NAME and ${NAME} from the environment", () => {
  process.env.PI_INTERPOLATE_TEST = "value-123";
  try {
    assert.equal(interpolate("prefix-$PI_INTERPOLATE_TEST"), "prefix-value-123");
    assert.equal(interpolate("${PI_INTERPOLATE_TEST}-suffix"), "value-123-suffix");
  } finally {
    delete process.env.PI_INTERPOLATE_TEST;
  }
});

test("interpolate treats a missing variable as an empty string", () => {
  assert.equal(interpolate("a-$PI_DEFINITELY_MISSING-b"), "a--b");
});

test("interpolate escapes $$ and $! as literals", () => {
  assert.equal(interpolate("cost $$5"), "cost $5");
  assert.equal(interpolate("$!not-a-command"), "!not-a-command");
});

test("resolveSecret returns undefined for undefined and passes literals through", () => {
  assert.equal(resolveSecret(undefined), undefined);
  assert.equal(resolveSecret("plain-key"), "plain-key");
});

test("resolveSecret runs !command and caches its output", () => {
  clearSecretCache();
  const first = resolveSecret("!echo cached-secret");
  const second = resolveSecret("!echo cached-secret");
  assert.equal(first, "cached-secret");
  assert.equal(second, "cached-secret");
});
