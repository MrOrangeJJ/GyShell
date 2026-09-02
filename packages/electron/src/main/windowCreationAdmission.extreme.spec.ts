import {
  normalizeAppWindowCreationOptions,
  type NormalizedAppWindowCreationOptions,
} from "./windowCreationAdmission";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assertJsonEqual = (
  actual: unknown,
  expected: unknown,
  message: string,
): void => {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
};

const runCase = (name: string, fn: () => void): void => {
  fn();
  console.log(`PASS ${name}`);
};

runCase("main window defaults are admitted without detached metadata", () => {
  assertJsonEqual(
    normalizeAppWindowCreationOptions(undefined),
    { role: "main", safeMode: false },
    "missing options should create the normal main window",
  );
  assertJsonEqual(
    normalizeAppWindowCreationOptions({ role: "main", safeMode: true }),
    { role: "main", safeMode: true },
    "main safe mode should be preserved",
  );
});

runCase("detached creation normalizes transport ids and preserves opaque tabs", () => {
  const exactTabId = "  Terminal #]::🙂  ";
  const normalized = normalizeAppWindowCreationOptions({
    role: "detached",
    detachedStateToken: "  detached-token  ",
    sourceClientId: "  source-client  ",
    tabOwnership: {
      chat: [exactTabId, exactTabId],
      terminal: [" terminal-id "],
    },
    safeMode: false,
  });
  assertJsonEqual(
    normalized,
    {
      role: "detached",
      detachedStateToken: "detached-token",
      sourceClientId: "source-client",
      tabOwnership: {
        chat: [exactTabId],
        terminal: [" terminal-id "],
        filesystem: [],
        monitor: [],
      },
      safeMode: false,
    } satisfies NormalizedAppWindowCreationOptions,
    "only transport ids may be trimmed",
  );
});

runCase("variant fields are presence-sensitive and closed", () => {
  const invalid: unknown[] = [
    null,
    [],
    { role: undefined },
    { role: "unknown" },
    { safeMode: undefined },
    { safeMode: "true" },
    { role: "main", detachedStateToken: "token" },
    { role: "main", sourceClientId: "source" },
    { role: "main", tabOwnership: {} },
    { role: "detached" },
    {
      role: "detached",
      detachedStateToken: undefined,
      sourceClientId: "source",
      tabOwnership: {},
    },
    {
      role: "detached",
      detachedStateToken: "token",
      sourceClientId: "   ",
      tabOwnership: {},
    },
    {
      role: "detached",
      detachedStateToken: "token",
      sourceClientId: "source",
      tabOwnership: undefined,
    },
    {
      role: "detached",
      detachedStateToken: "token",
      sourceClientId: "source",
      tabOwnership: { terminal: ["   "] },
    },
    { unknown: true },
  ];
  invalid.forEach((candidate, index) => {
    assertEqual(
      normalizeAppWindowCreationOptions(candidate),
      null,
      `malformed creation options ${index} must reject`,
    );
  });
});

runCase("prototype, symbol, and hostile proxy inputs fail closed", () => {
  const inherited = Object.assign(Object.create({ inherited: true }), {
    role: "main",
  });
  assertEqual(
    normalizeAppWindowCreationOptions(inherited),
    null,
    "prototype-bearing options must reject",
  );

  const symbolInput = { role: "main" } as Record<PropertyKey, unknown>;
  Object.defineProperty(symbolInput, Symbol("unexpected"), {
    value: true,
    enumerable: false,
  });
  assertEqual(
    normalizeAppWindowCreationOptions(symbolInput),
    null,
    "symbol keys must reject",
  );

  const ownProto = { role: "main" } as Record<string, unknown>;
  Object.defineProperty(ownProto, "__proto__", {
    value: "literal-key",
    enumerable: true,
    configurable: true,
  });
  assertEqual(
    normalizeAppWindowCreationOptions(ownProto),
    null,
    "own __proto__ keys must reject without mutating prototypes",
  );

  const throwingProxy = new Proxy(
    { role: "main" },
    {
      ownKeys: () => {
        throw new Error("hostile ownKeys trap");
      },
    },
  );
  assertEqual(
    normalizeAppWindowCreationOptions(throwingProxy),
    null,
    "proxy trap failures must reject",
  );
});

console.log("All native window creation admission extreme tests passed.");
