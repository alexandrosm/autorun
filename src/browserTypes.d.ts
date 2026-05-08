interface WakeLockSentinel extends EventTarget {
  released: boolean;
  type: "screen";
  release: () => Promise<void>;
}

interface WakeLock {
  request: (type: "screen") => Promise<WakeLockSentinel>;
}

interface Navigator {
  wakeLock?: WakeLock;
}
