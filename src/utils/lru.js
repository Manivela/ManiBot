// LRU capped by total weight (entry count by default). A Map keeps insertion
// order, so re-inserting on access leaves the least recent entry first.
const createLru = (maxWeight, weigh = () => 1, onEvict = () => {}) => {
  const entries = new Map();
  let total = 0;

  return {
    delete(key) {
      if (entries.has(key)) {
        total -= weigh(entries.get(key));
        entries.delete(key);
      }
    },

    get(key) {
      if (!entries.has(key)) {
        return undefined;
      }
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },

    set(key, value) {
      const weight = weigh(value);
      if (weight > maxWeight) {
        return;
      }
      if (entries.has(key)) {
        total -= weigh(entries.get(key));
        entries.delete(key);
      }
      entries.set(key, value);
      total += weight;
      for (const [oldKey, oldValue] of entries) {
        if (total <= maxWeight) {
          break;
        }
        entries.delete(oldKey);
        total -= weigh(oldValue);
        onEvict(oldKey, oldValue);
      }
    },
  };
};

module.exports = { createLru };
