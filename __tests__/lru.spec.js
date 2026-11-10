const { createLru } = require("../src/utils/lru");

describe("createLru", () => {
  it("evicts the least recently used entry, counting a read as use", () => {
    const lru = createLru(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a");
    lru.set("c", 3);

    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toBe(1);
    expect(lru.get("c")).toBe(3);
  });

  it("caps total weight, not entry count", () => {
    const lru = createLru(10, (buffer) => buffer.length);
    lru.set("a", Buffer.alloc(4));
    lru.set("b", Buffer.alloc(4));
    lru.set("a", Buffer.alloc(6)); // replacing re-weighs: 6 + 4 fits
    lru.set("c", Buffer.alloc(3)); // 13 > 10: evict "b" (oldest) -> 9

    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toHaveLength(6);
    expect(lru.get("c")).toHaveLength(3);
  });

  it("reports evictions, and delete frees the weight", () => {
    const evicted = [];
    const lru = createLru(
      10,
      (size) => size,
      (key) => evicted.push(key),
    );
    lru.set("a", 6);
    lru.set("b", 4);
    lru.delete("a");
    lru.set("c", 6); // fits only because "a" was deleted
    lru.set("d", 1); // 11 > 10: evict "b"

    expect(evicted).toEqual(["b"]);
    expect(lru.get("c")).toBe(6);
  });

  it("refuses an entry heavier than the whole cache", () => {
    const lru = createLru(10, (buffer) => buffer.length);
    lru.set("small", Buffer.alloc(2));
    lru.set("huge", Buffer.alloc(11));

    expect(lru.get("huge")).toBeUndefined();
    expect(lru.get("small")).toHaveLength(2);
  });
});
